import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { CompanyProfile } from '../types/erp';

export interface PdfPreviewPayload {
  title: string;
  filename: string;
  blobUrl: string;
  save: () => void;
}

type PdfPreviewHandler = (payload: PdfPreviewPayload) => void;
let pdfPreviewHandler: PdfPreviewHandler | null = null;

export function registerPdfPreviewHandler(handler: PdfPreviewHandler | null): void {
  pdfPreviewHandler = handler;
}

function outputOrPreviewPdf(doc: jsPDF, title: string, filename: string, directDownload = false): void {
  const cleanName = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;
  if (!directDownload && pdfPreviewHandler) {
    const blob = doc.output('blob');
    const blobUrl = URL.createObjectURL(blob);
    pdfPreviewHandler({
      title,
      filename: cleanName,
      blobUrl,
      save: () => doc.save(cleanName),
    });
    return;
  }
  doc.save(cleanName);
}

export function exportToExcel(filename: string, sheetName: string, rows: Record<string, unknown>[]): void {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

export function downloadLineItemsExcelTemplate(
  filename: string,
  rows: { item_code?: string; item_name?: string; qty?: number; uom?: string; rate?: number; vat_rate?: number; batch_number?: string; tank_code?: string }[]
): void {
  const data =
    rows.length > 0
      ? rows.map((r) => ({
          'Item Code': r.item_code || '',
          'Item Name': r.item_name || '',
          Quantity: r.qty ?? 100,
          UOM: r.uom || 'LTR',
          Rate: r.rate ?? 0,
          'VAT %': r.vat_rate ?? 5,
          'Batch No': r.batch_number || '',
          'Tank Code': r.tank_code || '',
        }))
      : [
          {
            'Item Code': 'RM-SN150',
            'Item Name': 'Base Oil Group I SN150',
            Quantity: 1000,
            UOM: 'LTR',
            Rate: 3.85,
            'VAT %': 5,
            'Batch No': '',
            'Tank Code': 'TK-BO-01',
          },
        ];
  exportToExcel(filename, 'Line_Items', data);
}

export async function parseLineItemsExcelFile(
  file: File
): Promise<{ item_code: string; qty: number; rate?: number; vat_rate?: number; batch_number?: string; tank_code?: string }[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
  return json
    .map((raw) => {
      const norm: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        norm[k.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')] = String(v ?? '').trim();
      }
      const item_code = norm.item_code || norm.item || norm.sku || '';
      const qty = Number(norm.quantity || norm.qty || 0);
      const rate = norm.rate !== undefined && norm.rate !== '' ? Number(norm.rate) : norm.unit_price ? Number(norm.unit_price) : undefined;
      const vat_rate = norm.vat !== undefined && norm.vat !== '' ? Number(norm.vat) : norm.vat_rate !== undefined && norm.vat_rate !== '' ? Number(norm.vat_rate) : undefined;
      const batch_number = norm.batch_no || norm.batch_number || norm.batch || '';
      const tank_code = norm.tank_code || norm.tank || '';
      return { item_code, qty, rate, vat_rate, batch_number, tank_code };
    })
    .filter((r) => r.item_code && r.qty > 0);
}

export function exportToCsv(filename: string, rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const escape = (val: unknown) => {
    const s = String(val ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

interface LoadedLogo {
  dataUrl: string;
  width: number;
  height: number;
}

async function loadLogoPngDataUrl(logoUrl?: string): Promise<LoadedLogo | null> {
  if (!logoUrl) return null;
  try {
    const resp = await fetch(logoUrl, { cache: 'no-store' });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = objUrl;
      });
      const canvas = document.createElement('canvas');
      const maxPx = 600;
      const scale = Math.min(1, maxPx / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      canvas.width = Math.max(1, Math.round((img.naturalWidth || 200) * scale));
      canvas.height = Math.max(1, Math.round((img.naturalHeight || 80) * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return {
        dataUrl: canvas.toDataURL('image/png'),
        width: canvas.width,
        height: canvas.height,
      };
    } finally {
      URL.revokeObjectURL(objUrl);
    }
  } catch {
    return null;
  }
}

export function numberToWords(amount: number, currency = 'AED'): string {
  const num = Math.max(0, Number(amount || 0));
  const whole = Math.floor(num + 1e-6);
  const decimals = Math.round((num - whole) * 100);

  const ones = [
    '',
    'One',
    'Two',
    'Three',
    'Four',
    'Five',
    'Six',
    'Seven',
    'Eight',
    'Nine',
    'Ten',
    'Eleven',
    'Twelve',
    'Thirteen',
    'Fourteen',
    'Fifteen',
    'Sixteen',
    'Seventeen',
    'Eighteen',
    'Nineteen',
  ];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const twoDigits = (n: number): string => {
    if (n === 0) return '';
    if (n < 20) return ones[n];
    const t = Math.floor(n / 10);
    const o = n % 10;
    return o ? `${tens[t]} ${ones[o]}` : tens[t];
  };

  const threeDigits = (n: number): string => {
    const h = Math.floor(n / 100);
    const rem = n % 100;
    const parts: string[] = [];
    if (h > 0) parts.push(`${ones[h]} Hundred`);
    if (rem > 0) {
      if (h > 0) parts.push(`And ${twoDigits(rem)}`);
      else parts.push(twoDigits(rem));
    }
    return parts.join(' ');
  };

  const convertWhole = (n: number): string => {
    if (n === 0) return 'Zero';
    const billions = Math.floor(n / 1_000_000_000);
    const millions = Math.floor((n % 1_000_000_000) / 1_000_000);
    const thousands = Math.floor((n % 1_000_000) / 1_000);
    const rest = n % 1_000;

    const chunks: string[] = [];
    if (billions) chunks.push(`${threeDigits(billions)} Billion`);
    if (millions) chunks.push(`${threeDigits(millions)} Million`);
    if (thousands) chunks.push(`${threeDigits(thousands)} Thousand`);
    if (rest) {
      if (chunks.length > 0 && rest < 100) chunks.push(`And ${twoDigits(rest)}`);
      else chunks.push(threeDigits(rest));
    }
    return chunks.join(', ');
  };

  const subUnit = currency === 'USD' ? 'Cents' : currency === 'EUR' ? 'Cents' : 'Fils';
  const wholeWords = convertWhole(whole);
  if (decimals > 0) {
    return `${currency} ${wholeWords} and ${twoDigits(decimals)} ${subUnit} only.`;
  }
  return `${currency} ${wholeWords} only.`;
}

function formatDateDMY(dateStr?: string): string {
  if (!dateStr) return '';
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return String(dateStr).slice(0, 10);
}

function formatTimestampNow(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${dd}-${mm}-${yyyy} ${hh}:${mi}:${ss}`;
}

export async function exportTableToPdf(
  filename: string,
  title: string,
  columns: { header: string; key: string }[],
  rows: Record<string, unknown>[],
  companyName = 'Company ERP',
  logoUrl?: string,
  directDownload = false
): Promise<void> {
  const doc = new jsPDF({ orientation: columns.length > 6 ? 'landscape' : 'portrait' });
  const logo = await loadLogoPngDataUrl(logoUrl);
  let startY = 30;
  if (logo) {
    const maxH = 12;
    const w = Math.min(40, (logo.width / logo.height) * maxH);
    const h = w * (logo.height / logo.width);
    doc.addImage(logo.dataUrl, 'PNG', 14, 10, w, h);
    doc.setFontSize(13);
    doc.text(companyName, 14 + w + 4, 16);
    doc.setFontSize(10.5);
    doc.text(title, 14 + w + 4, 22);
    startY = Math.max(28, 10 + h + 6);
  } else {
    doc.setFontSize(13);
    doc.text(companyName, 14, 14);
    doc.setFontSize(11);
    doc.text(title, 14, 21);
    doc.setFontSize(8);
    doc.text(`Generated: ${formatTimestampNow()}`, 14, 26);
  }

  autoTable(doc, {
    startY,
    head: [columns.map((c) => c.header)],
    body: rows.map((r) => columns.map((c) => String(r[c.key] ?? ''))),
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [15, 23, 42] },
  });

  outputOrPreviewPdf(doc, title, filename, directDownload);
}

export interface StandardErpLineItem {
  item_code?: string;
  description: string;
  qty: number | string;
  uom: string;
  unit_price: number;
  vat_pct: number;
  vat_amount: number;
  total: number;
}

export interface StandardErpPdfParams {
  docTitle: string; // e.g., 'PURCHASE ORDER', 'SALES ORDER', 'TAX INVOICE'
  docNumberLabel: string; // e.g., 'PO No.', 'SO No.', 'Invoice No.'
  docNumber: string;
  docDate: string;
  company: Partial<CompanyProfile>;
  logoUrl?: string;
  companyRole: 'Buyer' | 'Seller';
  partyRole: 'Seller' | 'Buyer';
  partyName: string;
  partyTrn?: string;
  partyAddress?: string;
  partyCountry?: string;
  partyContactPerson?: string;
  paymentTerms?: string;
  deliveryTerms?: string;
  deliveryDate?: string;
  deliveryPlace?: string;
  partyRefLabel?: string; // e.g., 'Suppliers Ref. No.' or 'Customer Ref. No.'
  partyRefNo?: string;
  exchangeRate?: number | string;
  revisionNo?: string;
  revisionDate?: string;
  currency?: string;
  items: StandardErpLineItem[];
  netTotal: number;
  vatTotal: number;
  grandTotal: number;
  remarks?: string;
  preparedBy?: string;
  reviewedBy?: string;
  authorizedBy?: string;
  creatorName?: string;
  filename?: string;
  directDownload?: boolean;
}

/**
 * Generates an official A4 Portrait PDF reproducing the standardized enterprise document layout:
 * - Centered company logo & document title
 * - Boxed Buyer/Seller & metadata grid (Doc No, Date, Payment/Delivery Terms, Delivery Date/Place, Ref No, Exchange Rate, Revision)
 * - Joined 9-column continuous vertical border line-items table
 * - Amount Chargeable in words + Net Total / VAT / Grand Total box
 * - PREPARED BY / REVIEWED BY / AUTHORIZED BY signature strip
 * - Creator Name, Page X of Y, timestamp & centered small logo mark at bottom
 */
export async function exportStandardErpPdf(params: StandardErpPdfParams): Promise<void> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const logo = await loadLogoPngDataUrl(params.logoUrl || params.company.logo_url);
  const currency = params.currency || params.company.currency || 'AED';

  const pageW = 210;
  const pageH = 297;
  const leftX = 10;
  const totalW = 190;
  const rightX = leftX + totalW;
  const leftColW = 90;
  const rightColW = totalW - leftColW; // 100
  const halfRightW = rightColW / 2; // 50

  const colWidths = [11, 22, 57, 16, 13, 21, 13, 18, 19]; // sums to 190
  const headers = [
    'Sr.\nNo.',
    'Item Code',
    'Description of Goods',
    'Quantity',
    'UOM',
    `Unit Price\n(${currency})`,
    'VAT\n%',
    `VAT AMT\n(${currency})`,
    `Total\n(${currency})`,
  ];

  const drawLogoAt = (cx: number, topY: number, maxW: number, maxH: number): number => {
    if (!logo) return 0;
    const ratio = logo.width / logo.height;
    let w = maxW;
    let h = w / ratio;
    if (h > maxH) {
      h = maxH;
      w = h * ratio;
    }
    doc.addImage(logo.dataUrl, 'PNG', cx - w / 2, topY, w, h);
    return h;
  };

  const drawWrapped = (text: string, x: number, y: number, maxW: number, lineH: number, maxLines = 4): number => {
    if (!text) return 0;
    const lines = doc.splitTextToSize(text, maxW) as string[];
    const clipped = lines.slice(0, maxLines);
    clipped.forEach((line, i) => {
      doc.text(line, x, y + i * lineH);
    });
    return clipped.length * lineH;
  };

  const drawHeaderOnPage = (): number => {
    doc.setDrawColor(0, 0, 0);
    doc.setTextColor(0, 0, 0);
    doc.setLineWidth(0.25);

    // Top centered logo
    let cursorY = 10;
    if (logo) {
      const lh = drawLogoAt(pageW / 2, cursorY, 55, 16);
      cursorY += lh + 4;
    } else {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.text(params.company.name || 'Company Name', pageW / 2, cursorY + 6, { align: 'center' });
      cursorY += 12;
    }

    // Document Title
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(params.docTitle.toUpperCase(), pageW / 2, cursorY + 3, { align: 'center' });
    const boxTop = cursorY + 7;

    // Top half of box (Buyer/Company + first 3 metadata rows) = 33mm
    const rowH = 11;
    const topHalfH = rowH * 3; // 33mm
    const botHalfH = 27; // bottom left Seller/Counterparty + 2 metadata rows (13.5 * 2 = 27mm)
    const botRowH = botHalfH / 2;
    const boxTotalH = topHalfH + botHalfH;

    // Outer box
    doc.rect(leftX, boxTop, totalW, boxTotalH);
    // Vertical split between left party column and right metadata grid
    doc.line(leftX + leftColW, boxTop, leftX + leftColW, boxTop + boxTotalH);
    // Horizontal divider between Buyer & Seller
    doc.line(leftX, boxTop + topHalfH, rightX, boxTop + topHalfH);

    // Right metadata grid lines
    const metaX1 = leftX + leftColW;
    const metaX2 = metaX1 + halfRightW;
    doc.line(metaX2, boxTop, metaX2, boxTop + boxTotalH);
    doc.line(metaX1, boxTop + rowH, rightX, boxTop + rowH);
    doc.line(metaX1, boxTop + rowH * 2, rightX, boxTop + rowH * 2);
    doc.line(metaX1, boxTop + topHalfH + botRowH, rightX, boxTop + topHalfH + botRowH);

    // Fill Top-Left block (Company)
    let ly = boxTop + 4.2;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.2);
    doc.text(`${params.companyRole} :`, leftX + 2, ly);
    ly += 4;
    doc.text(params.company.name || '', leftX + 2, ly);
    ly += 3.8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.8);
    if (params.company.address) {
      ly += drawWrapped(params.company.address, leftX + 2, ly, leftColW - 4, 3.4, 2);
    }
    if (params.company.po_box) {
      doc.text(`P.O. Box : ${params.company.po_box}`, leftX + 2, ly);
      ly += 3.5;
    }
    if (params.company.country) {
      doc.text(String(params.company.country).toUpperCase(), leftX + 2, ly);
      ly += 3.5;
    }
    if (params.company.trn) {
      doc.setFont('helvetica', 'bold');
      doc.text(`TRN : ${params.company.trn}`, leftX + 2, Math.min(boxTop + topHalfH - 1.5, ly));
    }

    // Fill Bottom-Left block (Counterparty)
    let py = boxTop + topHalfH + 4.2;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.2);
    doc.text(`${params.partyRole} :`, leftX + 2, py);
    py += 4;
    doc.text(params.partyName || '-', leftX + 2, py);
    py += 3.8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.8);
    if (params.partyTrn) {
      doc.text(`TRN : ${params.partyTrn}`, leftX + 2, py);
      py += 3.6;
    }
    const addrText = [params.partyAddress, params.partyCountry].filter(Boolean).join(', ');
    if (addrText) {
      py += drawWrapped(addrText, leftX + 2, py, leftColW - 4, 3.4, 2);
    }
    if (params.partyContactPerson) {
      doc.text(`Contact Person : ${params.partyContactPerson}`, leftX + 2, Math.min(boxTop + boxTotalH - 1.5, py));
    }

    // Fill Right Metadata Grid
    const drawCell = (cx: number, cy: number, label: string, value: string, boldValue = false) => {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.text(label, cx + 2, cy + 3.8);
      doc.setFont('helvetica', boldValue ? 'bold' : 'normal');
      doc.setFontSize(8);
      const valLines = doc.splitTextToSize(value || '-', halfRightW - 4) as string[];
      doc.text(valLines.slice(0, 2), cx + 2, cy + 8.1);
    };

    drawCell(metaX1, boxTop, params.docNumberLabel, params.docNumber, true);
    drawCell(metaX2, boxTop, 'Date', formatDateDMY(params.docDate), true);

    drawCell(metaX1, boxTop + rowH, 'Payment Terms', params.paymentTerms || '-');
    drawCell(metaX2, boxTop + rowH, 'Delivery Terms', params.deliveryTerms || '-');

    drawCell(metaX1, boxTop + rowH * 2, 'Delivery Date', formatDateDMY(params.deliveryDate) || '-');
    drawCell(metaX2, boxTop + rowH * 2, 'Delivery Place', params.deliveryPlace || '-');

    drawCell(metaX1, boxTop + topHalfH, params.partyRefLabel || 'Suppliers Ref. No.', params.partyRefNo || '-');
    drawCell(metaX2, boxTop + topHalfH, 'Exchange Rate', String(params.exchangeRate ?? '1.0'));

    drawCell(metaX1, boxTop + topHalfH + botRowH, 'Revision No.', params.revisionNo || 'Original');
    drawCell(metaX2, boxTop + topHalfH + botRowH, 'Revision Date', formatDateDMY(params.revisionDate) || '');

    return boxTop + boxTotalH;
  };

  // Start rendering pages
  let tableTopY = drawHeaderOnPage();
  const tableHeaderH = 9.5;
  const totalsH = 22;
  const sigTopGap = 5;
  const sigH = 21;
  const footerReserved = 26;
  const maxContentBottom = pageH - footerReserved - totalsH - sigTopGap - sigH; // ~223mm

  const drawTableHeader = (y: number) => {
    doc.setLineWidth(0.25);
    doc.setDrawColor(0, 0, 0);
    doc.rect(leftX, y, totalW, tableHeaderH);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.6);
    let cx = leftX;
    headers.forEach((h, i) => {
      if (i > 0) doc.line(cx, y, cx, y + tableHeaderH);
      const lines = h.split('\n');
      const alignCenter = cx + colWidths[i] / 2;
      if (lines.length === 1) {
        doc.text(lines[0], alignCenter, y + 6, { align: 'center' });
      } else {
        doc.text(lines[0], alignCenter, y + 4, { align: 'center' });
        doc.text(lines[1], alignCenter, y + 7.6, { align: 'center' });
      }
      cx += colWidths[i];
    });
  };

  const drawTableColumnBorders = (bodyTopY: number, bodyBottomY: number) => {
    doc.setLineWidth(0.25);
    doc.setDrawColor(0, 0, 0);
    doc.rect(leftX, bodyTopY, totalW, bodyBottomY - bodyTopY);
    let cx = leftX;
    for (let i = 0; i < colWidths.length - 1; i++) {
      cx += colWidths[i];
      doc.line(cx, bodyTopY, cx, bodyBottomY);
    }
  };

  drawTableHeader(tableTopY);
  let bodyStartY = tableTopY + tableHeaderH;
  let curY = bodyStartY + 4;

  const itemsList = params.items.length > 0 ? params.items : [];
  itemsList.forEach((item, idx) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.8);
    const descLines = doc.splitTextToSize(item.description || '', colWidths[2] - 3) as string[];
    const codeLines = doc.splitTextToSize(item.item_code || '', colWidths[1] - 2.5) as string[];
    const lineCount = Math.max(1, descLines.length, codeLines.length);
    const neededH = Math.max(6, lineCount * 3.6 + 2);

    if (curY + neededH > maxContentBottom) {
      drawTableColumnBorders(bodyStartY, maxContentBottom);
      doc.addPage();
      tableTopY = drawHeaderOnPage();
      drawTableHeader(tableTopY);
      bodyStartY = tableTopY + tableHeaderH;
      curY = bodyStartY + 4;
    }

    let cx = leftX;
    // Sr No
    doc.text(String(idx + 1), cx + colWidths[0] / 2, curY, { align: 'center' });
    cx += colWidths[0];

    // Item Code
    doc.text(codeLines, cx + 1.5, curY);
    cx += colWidths[1];

    // Description
    doc.text(descLines, cx + 1.5, curY);
    cx += colWidths[2];

    // Quantity
    doc.text(Number(item.qty || 0).toLocaleString('en-US', { maximumFractionDigits: 4 }), cx + colWidths[3] - 1.5, curY, { align: 'right' });
    cx += colWidths[3];

    // UOM
    doc.text(String(item.uom || ''), cx + colWidths[4] / 2, curY, { align: 'center' });
    cx += colWidths[4];

    // Unit Price
    doc.text(Number(item.unit_price || 0).toFixed(2), cx + colWidths[5] - 1.5, curY, { align: 'right' });
    cx += colWidths[5];

    // VAT %
    doc.text(Number(item.vat_pct || 0).toFixed(1), cx + colWidths[6] - 1.5, curY, { align: 'right' });
    cx += colWidths[6];

    // VAT AMT
    doc.text(Number(item.vat_amount || 0).toFixed(2), cx + colWidths[7] - 1.5, curY, { align: 'right' });
    cx += colWidths[7];

    // Total
    doc.text(Number(item.total || 0).toFixed(2), cx + colWidths[8] - 1.5, curY, { align: 'right' });

    curY += neededH;
  });

  // Optional Remarks near bottom of items body
  if (params.remarks) {
    const remLines = doc.splitTextToSize(`Remarks: ${params.remarks}`, colWidths[2] - 3) as string[];
    const remH = remLines.length * 3.5 + 3;
    if (curY + remH <= maxContentBottom) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(7.4);
      doc.text(remLines, leftX + colWidths[0] + colWidths[1] + 1.5, curY + 2);
    }
  }

  // Close items box down to maxContentBottom so layout matches DUMMY.pdf full-page frame
  const bodyBottomY = Math.max(curY + 2, maxContentBottom);
  drawTableColumnBorders(bodyStartY, bodyBottomY);

  // Totals Section
  const totalsTop = bodyBottomY;
  const wordsBoxW = 119; // matches left 5 columns (11+22+57+16+13 = 119)
  const totalsRightW = totalW - wordsBoxW; // 71
  const labelW = 34; // 21 + 13
  const totRowH = totalsH / 3;

  doc.setLineWidth(0.25);
  doc.rect(leftX, totalsTop, totalW, totalsH);
  doc.line(leftX + wordsBoxW, totalsTop, leftX + wordsBoxW, totalsTop + totalsH);
  doc.line(leftX + wordsBoxW + labelW, totalsTop, leftX + wordsBoxW + labelW, totalsTop + totalsH);
  doc.line(leftX + wordsBoxW, totalsTop + totRowH, rightX, totalsTop + totRowH);
  doc.line(leftX + wordsBoxW, totalsTop + totRowH * 2, rightX, totalsTop + totRowH * 2);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.8);
  doc.text('Amount Chargeable (in words):', leftX + 2, totalsTop + 5);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.2);
  const wordsText = numberToWords(params.grandTotal, currency);
  const wordLines = doc.splitTextToSize(wordsText, wordsBoxW - 4) as string[];
  doc.text(wordLines.slice(0, 2), leftX + 2, totalsTop + 10.5);

  const totRows: [string, string, boolean][] = [
    ['Net Total', Number(params.netTotal || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), false],
    ['VAT', Number(params.vatTotal || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), false],
    ['Grand Total', Number(params.grandTotal || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), true],
  ];
  totRows.forEach(([lbl, val, isBold], i) => {
    const ry = totalsTop + i * totRowH + 5;
    doc.setFont('helvetica', isBold ? 'bold' : 'normal');
    doc.setFontSize(8);
    doc.text(lbl, leftX + wordsBoxW + 2, ry);
    doc.text(val, rightX - 2, ry, { align: 'right' });
  });

  // Signature Strip
  const sigTop = totalsTop + totalsH + sigTopGap;
  const sigColW = totalW / 3;
  doc.rect(leftX, sigTop, totalW, sigH);
  doc.line(leftX + sigColW, sigTop, leftX + sigColW, sigTop + sigH);
  doc.line(leftX + sigColW * 2, sigTop, leftX + sigColW * 2, sigTop + sigH);

  const sigCols: [string, string | undefined][] = [
    ['PREPARED BY :', params.preparedBy || params.creatorName || ''],
    ['REVIEWED BY :', params.reviewedBy || ''],
    ['AUTHORIZED BY :', params.authorizedBy || ''],
  ];
  sigCols.forEach(([lbl, val], i) => {
    const sx = leftX + i * sigColW;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.8);
    doc.text(lbl, sx + 2, sigTop + 4.5);
    if (val) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.text(val, sx + 2, sigTop + 16);
    }
  });

  // Page Footer on all pages (Creator Name, Page X of Y, Timestamp, Bottom Logo mark)
  const totalPages = doc.getNumberOfPages();
  const timestamp = formatTimestampNow();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    const fy = pageH - 21;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.4);
    doc.setTextColor(60, 60, 60);
    if (params.creatorName) {
      doc.text(`Creator Name : ${params.creatorName}`, pageW / 2, fy, { align: 'center' });
    }
    doc.text(`Page ${p} of ${totalPages}`, pageW / 2, fy + 3.8, { align: 'center' });
    doc.text(timestamp, pageW / 2, fy + 7.6, { align: 'center' });
    if (logo) {
      drawLogoAt(pageW / 2, fy + 9.2, 18, 7.5);
    }
  }

  outputOrPreviewPdf(doc, `${params.docTitle} — ${params.docNumber}`, params.filename || params.docNumber || 'document', Boolean(params.directDownload));
}

export async function exportDocumentPdf(params: {
  title: string;
  docNumber: string;
  companyName: string;
  companyAddress?: string;
  companyTrn?: string;
  logoUrl?: string;
  meta: { label: string; value: string }[];
  columns: { header: string; key: string }[];
  lines: Record<string, unknown>[];
  totals?: { label: string; value: string }[];
  footerNote?: string;
  directDownload?: boolean;
}): Promise<void> {
  const doc = new jsPDF();
  const logo = await loadLogoPngDataUrl(params.logoUrl);
  let headerY = 16;
  if (logo) {
    const lh = Math.min(14, (logo.height / logo.width) * 38);
    const lw = lh * (logo.width / logo.height);
    doc.addImage(logo.dataUrl, 'PNG', 14, 10, lw, lh);
    headerY = 10 + lh + 6;
  }

  doc.setFontSize(14);
  doc.text(params.companyName, 14, headerY);
  doc.setFontSize(8.5);
  if (params.companyAddress) doc.text(params.companyAddress, 14, headerY + 5);
  if (params.companyTrn) doc.text(`TRN: ${params.companyTrn}`, 14, headerY + 9);

  doc.setFontSize(13);
  doc.text(`${params.title} — ${params.docNumber}`, 14, headerY + 18);

  let y = headerY + 25;
  doc.setFontSize(9);
  params.meta.forEach((m, idx) => {
    const colX = idx % 2 === 0 ? 14 : 110;
    if (idx > 0 && idx % 2 === 0) y += 6;
    doc.text(`${m.label}: ${m.value}`, colX, y);
  });

  autoTable(doc, {
    startY: y + 8,
    head: [params.columns.map((c) => c.header)],
    body: params.lines.map((r) => params.columns.map((c) => String(r[c.key] ?? ''))),
    styles: { fontSize: 8.5, cellPadding: 2.5 },
    headStyles: { fillColor: [15, 23, 42] },
  });

  const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || 120;
  if (params.totals && params.totals.length > 0) {
    let ty = finalY + 8;
    doc.setFontSize(9.5);
    for (const t of params.totals) {
      doc.text(`${t.label}: ${t.value}`, 135, ty);
      ty += 5.5;
    }
  }
  if (params.footerNote) {
    doc.setFontSize(8);
    doc.text(params.footerNote, 14, finalY + 28);
  }
  outputOrPreviewPdf(doc, `${params.title} — ${params.docNumber}`, params.docNumber, Boolean(params.directDownload));
}
