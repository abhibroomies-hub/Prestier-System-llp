import {
  formatLeadForSheetRow,
  SHEET_HEADERS,
  type LeadRecord,
} from '../utils/leadLogic';

export interface ConnectedSpreadsheet {
  spreadsheetId: string;
  spreadsheetUrl: string;
  title: string;
  sheetId: number;
  sheetName: string;
}

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export function extractSpreadsheetId(idOrUrl: string): string {
  const trimmed = idOrUrl.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const candidate = match ? match[1] : trimmed;
  if (!/^[a-zA-Z0-9-_]{15,120}$/.test(candidate)) {
    throw new Error('Please enter a valid Google Sheet URL or Spreadsheet ID.');
  }
  return candidate;
}

async function sheetsFetch<T>(
  accessToken: string,
  url: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg =
      (data as { error?: { message?: string } })?.error?.message ||
      `Google Sheets API error (${res.status})`;
    throw new Error(errMsg);
  }
  return data as T;
}

async function ensureSheetHeaders(
  accessToken: string,
  sheet: ConnectedSpreadsheet
): Promise<void> {
  const range = encodeURIComponent(`'${sheet.sheetName}'!A1:M1`);
  await sheetsFetch(
    accessToken,
    `${SHEETS_API_BASE}/${sheet.spreadsheetId}/values/${range}?valueInputOption=RAW`,
    {
      method: 'PUT',
      body: JSON.stringify({
        values: [Array.from(SHEET_HEADERS)],
      }),
    }
  );
}

export async function createPrestierSpreadsheet(
  accessToken: string
): Promise<ConnectedSpreadsheet> {
  const sheetTitle = 'Prestier Leads';
  const created = await sheetsFetch<{
    spreadsheetId: string;
    spreadsheetUrl: string;
    properties?: { title?: string };
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  }>(accessToken, SHEETS_API_BASE, {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        title: `Prestier System LLP — Live Leads (${new Date().toISOString().slice(0, 10)})`,
        timeZone: 'Asia/Kolkata',
      },
      sheets: [
        {
          properties: {
            title: sheetTitle,
            gridProperties: {
              frozenRowCount: 1,
            },
          },
        },
      ],
    }),
  });

  const firstSheet = created.sheets?.[0]?.properties;
  const connected: ConnectedSpreadsheet = {
    spreadsheetId: created.spreadsheetId,
    spreadsheetUrl:
      created.spreadsheetUrl ||
      `https://docs.google.com/spreadsheets/d/${created.spreadsheetId}/edit`,
    title: created.properties?.title || 'Prestier System LLP — Live Leads',
    sheetId: typeof firstSheet?.sheetId === 'number' ? firstSheet.sheetId : 0,
    sheetName: firstSheet?.title || sheetTitle,
  };

  await ensureSheetHeaders(accessToken, connected);
  return connected;
}

export async function inspectSpreadsheet(
  accessToken: string,
  idOrUrl: string
): Promise<ConnectedSpreadsheet> {
  const spreadsheetId = extractSpreadsheetId(idOrUrl);
  const meta = await sheetsFetch<{
    spreadsheetId: string;
    spreadsheetUrl?: string;
    properties?: { title?: string };
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  }>(accessToken, `${SHEETS_API_BASE}/${spreadsheetId}`);

  const preferred =
    meta.sheets?.find((s) => s.properties?.title === 'Prestier Leads') ||
    meta.sheets?.[0];

  const connected: ConnectedSpreadsheet = {
    spreadsheetId: meta.spreadsheetId,
    spreadsheetUrl:
      meta.spreadsheetUrl ||
      `https://docs.google.com/spreadsheets/d/${meta.spreadsheetId}/edit`,
    title: meta.properties?.title || 'Connected Google Sheet',
    sheetId: typeof preferred?.properties?.sheetId === 'number' ? preferred.properties.sheetId : 0,
    sheetName: preferred?.properties?.title || 'Sheet1',
  };

  await ensureSheetHeaders(accessToken, connected);
  return connected;
}

export async function upsertLeadInGoogleSheet(
  accessToken: string,
  sheet: ConnectedSpreadsheet,
  lead: LeadRecord
): Promise<void> {
  const idColRange = encodeURIComponent(`'${sheet.sheetName}'!A2:A2000`);
  const existingCol = await sheetsFetch<{ values?: string[][] }>(
    accessToken,
    `${SHEETS_API_BASE}/${sheet.spreadsheetId}/values/${idColRange}`
  );

  const ids = existingCol.values || [];
  let targetRowNumber = -1;
  for (let i = 0; i < ids.length; i++) {
    if ((ids[i]?.[0] || '').trim() === lead.leadId) {
      targetRowNumber = i + 2;
      break;
    }
  }

  const rowValues = formatLeadForSheetRow(lead);
  if (targetRowNumber >= 2) {
    const updateRange = encodeURIComponent(
      `'${sheet.sheetName}'!A${targetRowNumber}:M${targetRowNumber}`
    );
    await sheetsFetch(
      accessToken,
      `${SHEETS_API_BASE}/${sheet.spreadsheetId}/values/${updateRange}?valueInputOption=RAW`,
      {
        method: 'PUT',
        body: JSON.stringify({ values: [rowValues] }),
      }
    );
  } else {
    const appendRange = encodeURIComponent(`'${sheet.sheetName}'!A:M`);
    await sheetsFetch(
      accessToken,
      `${SHEETS_API_BASE}/${sheet.spreadsheetId}/values/${appendRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        body: JSON.stringify({ values: [rowValues] }),
      }
    );
  }
}

export async function deleteLeadFromGoogleSheet(
  accessToken: string,
  sheet: ConnectedSpreadsheet,
  leadId: string
): Promise<void> {
  const idColRange = encodeURIComponent(`'${sheet.sheetName}'!A2:A2000`);
  const existingCol = await sheetsFetch<{ values?: string[][] }>(
    accessToken,
    `${SHEETS_API_BASE}/${sheet.spreadsheetId}/values/${idColRange}`
  );

  const ids = existingCol.values || [];
  const deleteRequests: Array<Record<string, unknown>> = [];
  for (let i = ids.length - 1; i >= 0; i--) {
    if ((ids[i]?.[0] || '').trim() === leadId) {
      const zeroBasedRowIndex = i + 1;
      deleteRequests.push({
        deleteDimension: {
          range: {
            sheetId: sheet.sheetId,
            dimension: 'ROWS',
            startIndex: zeroBasedRowIndex,
            endIndex: zeroBasedRowIndex + 1,
          },
        },
      });
    }
  }

  if (deleteRequests.length > 0) {
    await sheetsFetch(
      accessToken,
      `${SHEETS_API_BASE}/${sheet.spreadsheetId}:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({ requests: deleteRequests }),
      }
    );
  }
}

export async function syncAllLeadsToGoogleSheet(
  accessToken: string,
  sheet: ConnectedSpreadsheet,
  leads: LeadRecord[]
): Promise<number> {
  const clearRange = encodeURIComponent(`'${sheet.sheetName}'!A2:M2000`);
  await sheetsFetch(
    accessToken,
    `${SHEETS_API_BASE}/${sheet.spreadsheetId}/values/${clearRange}:clear`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    }
  );

  const allValues = [
    Array.from(SHEET_HEADERS),
    ...leads.map((lead) => formatLeadForSheetRow(lead)),
  ];

  const writeRange = encodeURIComponent(`'${sheet.sheetName}'!A1:M${allValues.length}`);
  await sheetsFetch(
    accessToken,
    `${SHEETS_API_BASE}/${sheet.spreadsheetId}/values/${writeRange}?valueInputOption=RAW`,
    {
      method: 'PUT',
      body: JSON.stringify({ values: allValues }),
    }
  );

  return leads.length;
}
