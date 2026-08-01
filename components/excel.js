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
} from "./ui.js";
import { validateBulkProjectKey } from "./validation.js";
import { loadExcelJS, parseSheetRows, buildReport } from "./xlsx.js";

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
      dropzoneHint.textContent = "Click to select a different report";
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
  if (!state.importData) return;

  try {
    const ExcelJS = await loadExcelJS();
    const workbook = new ExcelJS.Workbook();
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

    const ts = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${pad(ts.getDate())}_${pad(ts.getMonth() + 1)}_${ts.getFullYear()}_${pad(ts.getHours())}_${pad(ts.getMinutes())}_${pad(ts.getSeconds())}`;

    downloadBlob(
      `Octane_jira_export_${stamp}.${state.importExt || "xlsx"}`,
      await workbook.xlsx.writeBuffer(),
    );
  } catch (err) {
    console.error("ExcelJS export failed:", err);
    setStatus("Couldn't download the report.", "error");
  }
}

export function downloadBlob(filename, data) {
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
