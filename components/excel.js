import {
  state,
  fileInput,
  fileError,
  previewSection,
  progressSection,
  exportBtn,
  dropzoneHint,
  fileSummary,
  setStatus,
  setDropzoneLoaded,
  resetDropzone,
  loadBulkRows,
  unlockBulkImport,
  applyListingState,
} from "./ui.js";
import { validateBulkProjectKey } from "./validation.js";
import { loadExcelJS, parseSheetRows, buildReport } from "./xlsx.js";
import { detectTabState } from "./scrape.js";

export function handleFileSelected() {
  const file = fileInput.files[0];
  fileError.style.display = "none";
  previewSection.style.display = "none";
  progressSection.style.display = "none";
  exportBtn.style.display = "none";
  state.bulkRows = [];
  unlockBulkImport();

  if (!file) return;

  setDropzoneLoaded();
  dropzoneHint.textContent = "Reading file…";

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const ExcelJS = await loadExcelJS();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(e.target.result);
      state.importData = e.target.result;
      state.importExt = file.name.includes(".")
        ? file.name.split(".").pop().toLowerCase()
        : "xlsx";
      const sheet = workbook.worksheets[0];
      const parsed = parseSheetRows(sheet);

      if (!parsed.rows.length) {
        resetDropzone();
        fileError.textContent =
          'No usable rows found — expected "ID"/"Name"/"Description" (Octane) or "Number"/"Short description"/"Description" (Spark) columns.';
        fileError.style.display = "block";
        return;
      }

      loadBulkRows(parsed.rows, parsed.site);
      dropzoneHint.innerHTML = `<span class="dropzone-switch-hint">Click to select different report</span><br/><span class="dropzone-clear-hint">Click clear to switch to ${parsed.site} importing</span>`;
      // Re-derive the listing state from the tab: the clear affordance only
      // helps when a site import can actually run, and the listing-only
      // controls stay hidden while the report is loaded.
      detectTabState().then(({ listing, selectedCount }) =>
        applyListingState(listing, selectedCount),
      );
      fileSummary.textContent = `${parsed.rows.length} row(s) loaded.`;
      validateBulkProjectKey();
    } catch (err) {
      resetDropzone();
      fileError.textContent = `Couldn't read that file: ${err.message}`;
      fileError.style.display = "block";
    }
  };
  reader.onerror = () => {
    resetDropzone();
    fileError.textContent = "Failed to read the file.";
    fileError.style.display = "block";
  };
  reader.readAsArrayBuffer(file);
}

export async function downloadPreviewReport() {
  try {
    const ExcelJS = await loadExcelJS();

    let workbook;
    if (state.importData) {
      workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(state.importData);

      const rows = state.bulkRows.map((r) => {
        const statusLink = r.statusEl.querySelector("a");
        return statusLink
          ? {
              rowIndex: r.rowIndex,
              text: statusLink.textContent.trim(),
              href: statusLink.getAttribute("href"),
            }
          : {
              rowIndex: r.rowIndex,
              text: r.statusEl.textContent.trim().replace(/\s+/g, " "),
            };
      });

      buildReport(workbook, rows);
    } else {
      // No source file (listing page flow) — build a fresh report from the
      // preview rows themselves.
      workbook = buildOctaneReportWorkbook(ExcelJS, state.bulkRows);
    }

    const ts = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${pad(ts.getDate())}_${pad(ts.getMonth() + 1)}_${ts.getFullYear()}_${pad(ts.getHours())}_${pad(ts.getMinutes())}_${pad(ts.getSeconds())}`;
    const siteTag = String(state.bulkRows[0]?.site || "Octane").toLowerCase();

    downloadBlob(
      `${siteTag}_jira_export_${stamp}.${state.importExt || "xlsx"}`,
      await workbook.xlsx.writeBuffer(),
    );
  } catch (err) {
    console.error("ExcelJS export failed:", err);
    setStatus("Couldn't download the report.", "error");
  }
}

// Builds a Status/<ID-or-Number>/<Name-or-Short description>/Description
// workbook straight from the preview rows when there is no source file to
// stamp (the listing page import flow). The header schema follows the row
// site so the export round-trips: re-importing a Spark report is detected
// as Spark (Number/Short description) instead of being misread as Octane.
function buildOctaneReportWorkbook(ExcelJS, bulkRows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Report");

  const isSpark = String(bulkRows[0]?.site || "Octane") === "Spark";

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

  sheet.columns = isSpark
    ? [
        { header: "Status", width: 24 },
        { header: "Number", width: 14 },
        { header: "Short description", width: 40 },
        { header: "Description", width: 50 },
      ]
    : [
        { header: "Status", width: 24 },
        { header: "ID", width: 14 },
        { header: "Name", width: 40 },
        { header: "Description", width: 50 },
      ];

  sheet.getRow(1).eachCell((cell) => {
    cell.font = headerFont;
    cell.fill = headerFill;
  });

  bulkRows.forEach((r, i) => {
    const row = sheet.getRow(i + 2);

    const statusLink = r.statusEl.querySelector("a");
    if (statusLink) {
      const cell = row.getCell(1);
      cell.value = {
        text: statusLink.textContent.trim(),
        hyperlink: statusLink.getAttribute("href"),
      };
      cell.font = linkFont;
    } else {
      row.getCell(1).value = r.statusEl.textContent.trim().replace(/\s+/g, " ");
    }

    const idCell = row.getCell(2);
    if (r.sourceUrl) {
      idCell.value = { text: r.idText || r.sourceUrl, hyperlink: r.sourceUrl };
      idCell.font = linkFont;
    } else {
      idCell.value = r.idText || "";
    }

    row.getCell(3).value = r.name || "";
    row.getCell(4).value = r.description || "";
  });

  return workbook;
}

function downloadBlob(filename, data) {
  const blob =
    data instanceof Blob
      ? data
      : new Blob([data], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
