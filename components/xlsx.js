

let exceljsPromise = null;

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

export function readCell(row, colIdx) {
  if (colIdx < 0) return { text: "", url: "", linked: false };
  const cell = row.getCell(colIdx + 1);
  const text = String(cell.text ?? "").trim();
  const rawUrl = String(cell.hyperlink ?? "").trim();
  return { text, url: rawUrl || text, linked: Boolean(rawUrl) };
}

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

  if (descIdx === shortIdx) descIdx = -1;

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

        sourceUrl: idCell.linked ? idCell.url : "",
        idText: idCell.text,
      });
    }
    return { site: "Spark", rows: parsed };
  }

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

  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      if (cell.hyperlink) cell.font = linkFont;
    });
  });

  return workbook;
}
