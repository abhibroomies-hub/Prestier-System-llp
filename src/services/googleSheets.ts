import { formatLeadForSheetRow, SHEET_HEADERS, type LeadRecord } from '../utils/leadLogic';

export interface ConnectedSpreadsheet {
  spreadsheetId: string;
  spreadsheetUrl: string;
  title: string;
  sheetName: string;
  sheetId: number;
}

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

async function sheetsFetch(url: string, accessToken: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const message = errBody?.error?.message || `Google Sheets API error (${res.status})`;
    throw new Error(message);
  }
  return res.json();
}

/**
 * Creates a new colorful, formatted "Prestier System LLP — Live Leads" Google Sheet
 * with styled header bar, frozen header row, column widths, and conditional status colors.
 */
export async function createPrestierSpreadsheet(
  accessToken: string,
  title = 'Prestier System LLP — Live Leads'
): Promise<ConnectedSpreadsheet> {
  const created = await sheetsFetch(SHEETS_API_BASE, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title },
      sheets: [
        {
          properties: {
            title: 'Live Leads',
            gridProperties: {
              rowCount: 1000,
              columnCount: SHEET_HEADERS.length,
              frozenRowCount: 1,
            },
            tabColorStyle: {
              rgbColor: { red: 0.05, green: 0.45, blue: 0.78 },
            },
          },
        },
      ],
    }),
  });

  const spreadsheetId: string = created.spreadsheetId;
  const spreadsheetUrl: string =
    created.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  const firstSheet = created.sheets?.[0]?.properties;
  const sheetName: string = firstSheet?.title || 'Live Leads';
  const sheetId: number = firstSheet?.sheetId ?? 0;

  // Write headers in Row 1
  const headerRange = encodeURIComponent(`'${sheetName}'!A1:J1`);
  await sheetsFetch(
    `${SHEETS_API_BASE}/${spreadsheetId}/values/${headerRange}?valueInputOption=USER_ENTERED`,
    accessToken,
    {
      method: 'PUT',
      body: JSON.stringify({
        values: [[...SHEET_HEADERS]],
      }),
    }
  );

  // Apply colorful industrial table formatting + conditional formatting for Partial vs Confirmed
  await sheetsFetch(`${SHEETS_API_BASE}/${spreadsheetId}:batchUpdate`, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: SHEET_HEADERS.length,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.06, green: 0.11, blue: 0.2 },
                textFormat: {
                  foregroundColor: { red: 1, green: 1, blue: 1 },
                  bold: true,
                  fontSize: 10,
                },
                horizontalAlignment: 'LEFT',
                verticalAlignment: 'MIDDLE',
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
          },
        },
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [
                {
                  sheetId,
                  startRowIndex: 1,
                  endRowIndex: 1000,
                  startColumnIndex: 0,
                  endColumnIndex: SHEET_HEADERS.length,
                },
              ],
              booleanRule: {
                condition: {
                  type: 'CUSTOM_FORMULA',
                  values: [{ userEnteredValue: '=$B2="CONFIRMED"' }],
                },
                format: {
                  backgroundColor: { red: 0.91, green: 0.98, blue: 0.94 },
                },
              },
            },
            index: 0,
          },
        },
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [
                {
                  sheetId,
                  startRowIndex: 1,
                  endRowIndex: 1000,
                  startColumnIndex: 0,
                  endColumnIndex: SHEET_HEADERS.length,
                },
              ],
              booleanRule: {
                condition: {
                  type: 'CUSTOM_FORMULA',
                  values: [{ userEnteredValue: '=$B2="PARTIAL (LIVE DRAFT)"' }],
                },
                format: {
                  backgroundColor: { red: 1.0, green: 0.97, blue: 0.89 },
                },
              },
            },
            index: 1,
          },
        },
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId,
              dimension: 'COLUMNS',
              startIndex: 0,
              endIndex: SHEET_HEADERS.length,
            },
          },
        },
      ],
    }),
  });

  return {
    spreadsheetId,
    spreadsheetUrl,
    title,
    sheetName,
    sheetId,
  };
}

/**
 * Connects to an existing Google Spreadsheet by ID or full URL and discovers the actual first sheet tab name.
 */
export async function inspectSpreadsheet(
  accessToken: string,
  spreadsheetIdOrUrl: string
): Promise<ConnectedSpreadsheet> {
  const match = spreadsheetIdOrUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const spreadsheetId = (match ? match[1] : spreadsheetIdOrUrl).trim();
  if (!spreadsheetId || !/^[a-zA-Z0-9-_]{10,128}$/.test(spreadsheetId)) {
    throw new Error('Enter a valid Google Spreadsheet ID or URL.');
  }

  const meta = await sheetsFetch(
    `${SHEETS_API_BASE}/${spreadsheetId}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties(sheetId,title)`,
    accessToken
  );

  const firstSheet = meta.sheets?.[0]?.properties;
  if (!firstSheet?.title) {
    throw new Error('No sheet tabs found inside this spreadsheet.');
  }

  return {
    spreadsheetId: meta.spreadsheetId,
    spreadsheetUrl:
      meta.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${meta.spreadsheetId}/edit`,
    title: meta.properties?.title || 'Connected Google Sheet',
    sheetName: firstSheet.title,
    sheetId: firstSheet.sheetId ?? 0,
  };
}

/**
 * Ensures header row exists and upserts a single lead row in place (updating partial drafts seamlessly without duplicates).
 */
export async function upsertLeadInGoogleSheet(
  accessToken: string,
  sheet: ConnectedSpreadsheet,
  lead: LeadRecord
): Promise<number> {
  const colARange = encodeURIComponent(`'${sheet.sheetName}'!A1:A1000`);
  const existingData = await sheetsFetch(
    `${SHEETS_API_BASE}/${sheet.spreadsheetId}/values/${colARange}`,
    accessToken
  );

  const rows: string[][] = Array.isArray(existingData.values) ? existingData.values : [];

  // Ensure headers exist in Row 1
  if (rows.length === 0 || rows[0]?.[0] !== SHEET_HEADERS[0]) {
    const headerRange = encodeURIComponent(`'${sheet.sheetName}'!A1:J1`);
    await sheetsFetch(
      `${SHEETS_API_BASE}/${sheet.spreadsheetId}/values/${headerRange}?valueInputOption=USER_ENTERED`,
      accessToken,
      {
        method: 'PUT',
        body: JSON.stringify({ values: [[...SHEET_HEADERS]] }),
      }
    );
  }

  const matchIdx = rows.findIndex((r, idx) => idx > 0 && r?.[0] === lead.leadId);
  const rowValues = formatLeadForSheetRow(lead);

  if (matchIdx > 0) {
    const rowNumber = matchIdx + 1;
    const updateRange = encodeURIComponent(`'${sheet.sheetName}'!A${rowNumber}:J${rowNumber}`);
    await sheetsFetch(
      `${SHEETS_API_BASE}/${sheet.spreadsheetId}/values/${updateRange}?valueInputOption=USER_ENTERED`,
      accessToken,
      {
        method: 'PUT',
        body: JSON.stringify({ values: [rowValues] }),
      }
    );
    return rowNumber;
  }

  const appendRange = encodeURIComponent(`'${sheet.sheetName}'!A1:J1`);
  const appended = await sheetsFetch(
    `${SHEETS_API_BASE}/${sheet.spreadsheetId}/values/${appendRange}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({ values: [rowValues] }),
    }
  );
  const updatedRange: string = appended?.updates?.updatedRange || '';
  const rowMatch = updatedRange.match(/(\d+)$/);
  return rowMatch ? Number(rowMatch[1]) : rows.length + 1;
}

/**
 * Syncs all leads cleanly into the connected Google Sheet (preserving headers & upserting rows).
 */
export async function syncAllLeadsToGoogleSheet(
  accessToken: string,
  sheet: ConnectedSpreadsheet,
  leads: LeadRecord[]
): Promise<number> {
  const values: string[][] = [[...SHEET_HEADERS], ...leads.map(formatLeadForSheetRow)];
  const range = encodeURIComponent(`'${sheet.sheetName}'!A1:J${values.length}`);
  await sheetsFetch(
    `${SHEETS_API_BASE}/${sheet.spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    accessToken,
    {
      method: 'PUT',
      body: JSON.stringify({ values }),
    }
  );
  return leads.length;
}
