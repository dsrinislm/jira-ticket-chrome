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

// Reads a cell's display text plus its hyperlink target. The URL falls
// back to the display text when the cell isn't linked.
export function readCell(worksheet, row, colIdx) {
  if (colIdx < 0) return { text: "", url: "" };
  const cell = worksheet.getCell(row, colIdx + 1);
  const text = String(cell.text ?? "").trim();
  const url = String(cell.hyperlink ?? "").trim();
  return { text, url: url || text };
}

// Reads rows from the first worksheet as
// { name, description, sourceUrl, idText, rowIndex }. Columns are matched by
// header (case-insensitive, substring-tolerant) so variations like "Name",
// "ID", "Id", "Description" all work. For the ID column we keep both the
// display text (what the cell shows) and the hyperlink URL, since linked
// cells store the real address in cell.hyperlink while the cell.text holds
// the displayed value.
export function parseSheetRows(worksheet) {
  const headers = [];
  worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber - 1] = String(cell.text).trim().toLowerCase();
  });

  const findCol = (needle) => {
    const exact = headers.indexOf(needle);
    if (exact !== -1) return exact;
    return headers.findIndex((h) => h.includes(needle));
  };

  const nameIdx = findCol("name");
  if (nameIdx < 0) return [];

  const descIdx = findCol("description");
  const idIdx = findCol("id");

  const parsed = [];
  for (let r = 2; r <= worksheet.actualRowCount; r++) {
    const name = String(worksheet.getCell(r, nameIdx + 1).text ?? "").trim();
    if (!name) continue;

    const idCell = readCell(worksheet, r, idIdx);
    parsed.push({
      rowIndex: r - 1,
      name,
      description:
        descIdx < 0
          ? ""
          : String(worksheet.getCell(r, descIdx + 1).text ?? "").trim(),
      sourceUrl: idCell.url,
      idText: idCell.text,
    });
  }
  return parsed;
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
