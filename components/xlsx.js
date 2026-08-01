// Pure ExcelJS logic — no DOM access, so it's unit-testable in Node.
// ExcelJS itself is loaded lazily (see loadExcelJS) and only when a file
// is actually imported or the report is exported.

let exceljsPromise = null;

// Loads the ExcelJS UMD bundle on first use and caches the constructor.
// In the browser the UMD sets globalThis.ExcelJS; in Node tests it can be
// injected directly by setting globalThis.ExcelJS beforehand.
export async function loadExcelJS() {
  if (globalThis.ExcelJS) return globalThis.ExcelJS;
  if (!exceljsPromise) {
    exceljsPromise = import("../libraries/exceljs.min.js").then((ns) => {
      const resolved = globalThis.ExcelJS || ns.default || ns.ExcelJS;
      if (!resolved) throw new Error("ExcelJS failed to load");
      globalThis.ExcelJS = resolved;
      return resolved;
    });
  }
  return exceljsPromise;
}

// Reads a cell's display text plus its hyperlink target. `linked` tells
// callers whether the cell really holds a hyperlink (vs a plain value) —
// needed so a Spark "Number" cell only becomes a source URL when it's
// actually clickable. `url` falls back to the display text for the Octane
// ID flow, which has always relied on it.
export function readCell(row, colIdx) {
  if (colIdx < 0) return { text: "", url: "", linked: false };
  const cell = row.getCell(colIdx + 1);
  const text = String(cell.text ?? "").trim();
  const rawUrl = String(cell.hyperlink ?? "").trim();
  return { text, url: rawUrl || text, linked: Boolean(rawUrl) };
}

// Reads rows from the first worksheet as
// { site, rows: [{ name, description, sourceUrl, idText, rowIndex }] }.
//
// Two schemas are supported, detected from the header row:
//  - Octane: "ID" / "Name" / "Description"
//  - Spark:  "Number" / "Short description" / "Description", with a
//    combined "Comments and Work notes" column appended to the issue body
//
// Columns are matched by header (case-insensitive, substring-tolerant,
// underscores treated as spaces). For the ID/Number column we keep both
// the display text and the hyperlink URL, since linked cells store the
// real address in cell.hyperlink while cell.text holds the displayed value.
export function parseSheetRows(worksheet) {
  const headers = [];
  worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber - 1] = String(cell.text)
      .trim()
      .toLowerCase()
      .replace(/_/g, " ");
  });

  const findCol = (needle) => {
    const exact = headers.indexOf(needle);
    if (exact !== -1) return exact;
    return headers.findIndex((h) => h.includes(needle));
  };

  const readText = (row, idx) =>
    idx < 0 ? "" : String(row.getCell(idx + 1).text ?? "").trim();

  const numberIdx = findCol("number");
  const shortIdx = findCol("short description");
  let descIdx = findCol("description");
  // "Short description" also matches a bare "description" search — a file
  // needs a distinct Description column, not just the short one.
  if (descIdx === shortIdx) descIdx = -1;

  // Spark: Number / Short description / Description (+ "Comments and Work
  // notes" single column). Tolerates separate Comments/Work notes columns
  // as a fallback for older exports.
  if (numberIdx >= 0 && shortIdx >= 0 && descIdx >= 0) {
    const notesIdx = findCol("comments and work notes");
    const commentsIdx = findCol("comments");
    const workNotesIdx = findCol("work notes");
    const parsed = [];
    for (let r = 2; r <= worksheet.actualRowCount; r++) {
      const row = worksheet.getRow(r);
      const name = readText(row, shortIdx);
      if (!name) continue;
      const idCell = readCell(row, numberIdx);
      const desc = readText(row, descIdx);
      const notes =
        readText(row, notesIdx) ||
        [commentsIdx, workNotesIdx]
          .map((idx) => readText(row, idx))
          .filter(Boolean)
          .join("\n\n");
      const description = [
        desc,
        notes && `COMMENTS AND WORK NOTES\n${notes}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      parsed.push({
        rowIndex: r - 1,
        name,
        description,
        // Source URL only when the Number cell is actually a clickable link.
        sourceUrl: idCell.linked ? idCell.url : "",
        idText: idCell.text,
      });
    }
    return { site: "Spark", rows: parsed };
  }

  // Octane: ID / Name / Description
  const nameIdx = findCol("name");
  const idIdx = findCol("id");
  if (idIdx >= 0 && nameIdx >= 0 && descIdx >= 0) {
    const parsed = [];
    for (let r = 2; r <= worksheet.actualRowCount; r++) {
      const row = worksheet.getRow(r);
      const name = readText(row, nameIdx);
      if (!name) continue;
      const idCell = readCell(row, idIdx);
      parsed.push({
        rowIndex: r - 1,
        name,
        description: readText(row, descIdx),
        sourceUrl: idCell.url,
        idText: idCell.text,
      });
    }
    return { site: "Octane", rows: parsed };
  }

  return { site: null, rows: [] };
}

// Turns the imported workbook into the download report, in place:
//  - drops native Excel tables (ExcelJS round-trips them incorrectly,
//    and a stale table ref/headerRowCount is what made Excel flag the
//    file as corrupt)
//  - inserts a Status column (A), styling the whole header row
//  - writes each row's result (text + optional link) into column A
//  - re-styles any hyperlink cell as a blue underline
// rows: [{ rowIndex, text, href? }] where rowIndex is 0-based.
export function buildReport(workbook, rows) {
  const sheet = workbook.worksheets[0];

  for (const name of Object.keys(sheet.tables || {})) {
    sheet.removeTable(name);
  }

  sheet.spliceColumns(1, 0, []);
  sheet.getColumn(1).width = 18;

  const headerFont = {
    name: "Arial",
    size: 11,
    bold: true,
    color: { argb: "FFFFFFFF" },
  };
  const headerFill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF0097EF" },
  };
  const linkFont = {
    name: "Calibri",
    size: 11,
    underline: "single",
    color: { argb: "FF0000FF" },
  };

  const lastCol = sheet.columnCount;

  for (let c = 1; c <= lastCol; c++) {
    const cell = sheet.getCell(1, c);
    cell.font = headerFont;
    cell.fill = headerFill;
  }

  sheet.getCell("A1").value = "Status";

  rows.forEach((r) => {
    const cell = sheet.getCell(r.rowIndex + 1, 1);
    if (r.href) {
      cell.value = { text: r.text, hyperlink: r.href };
      cell.font = linkFont;
    } else if (r.text) {
      cell.value = r.text;
    }
  });

  // Only touch cells that actually exist — avoids materializing every
  // cell in the grid (a nested getCell(r,c) loop does O(rows*cols) work
  // on large imports).
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      if (cell.hyperlink) cell.font = linkFont;
    });
  });

  return workbook;
}
