// index.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");

const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "state.json");

// Load config
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

// Load or initialize state
let state = { seen_ids: [] };
if (fs.existsSync(STATE_PATH)) {
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch (e) {
    console.warn("Failed to parse state.json, starting fresh.");
  }
  if (!"seen_ids" in state) {
    state = { seen_ids: [] };
  }
}

// DST helper for US Eastern Time
function isETDST(date) {
  // date: JS Date in UTC
  const year = date.getUTCFullYear();
  // Second Sunday in March
  const march = new Date(Date.UTC(year, 2, 1));
  const marchDay = march.getUTCDay();
  const firstSundayMarch = marchDay === 0 ? 1 : 8 - marchDay;
  const secondSundayMarch = firstSundayMarch + 7;
  const dstStart = new Date(Date.UTC(year, 2, secondSundayMarch, 7)); // 2am ET = 7am UTC
  // First Sunday in November
  const november = new Date(Date.UTC(year, 10, 1));
  const novemberDay = november.getUTCDay();
  const firstSundayNov = novemberDay === 0 ? 1 : 8 - novemberDay;
  const dstEnd = new Date(Date.UTC(year, 10, firstSundayNov, 6)); // 2am ET = 6am UTC
  return date >= dstStart && date < dstEnd;
}

function formatMMDDYYYY_HHMMSS(date) {
  // Returns MM/DD/YYYY HH:mm:ss in UTC
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const yyyy = date.getUTCFullYear();
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${mm}/${dd}/${yyyy} ${hh}:${min}:${ss}`;
}

// Google Sheets setup
async function getSheetsClient() {
  const auth = new GoogleAuth({
    keyFile: path.join(__dirname, "service_account.json"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

// API helpers
const API_ROOT = "https://nmg-league.foxlisk.com/api/v1";

async function fetchScheduledRaces(season) {
  const url = `${API_ROOT}/season/${season}/races?state=%22Scheduled%22`;
  const res = await axios.get(url);
  if (res.data && res.data.Ok) return res.data.Ok;
  throw new Error("Failed to fetch races");
}

async function fetchPlayers(ids) {
  if (!ids.length) return {};
  const params = ids.map((id) => `player_id=${id}`).join("&");
  const url = `${API_ROOT}/players?${params}`;
  const res = await axios.get(url);
  if (res.data && res.data.Ok) {
    const map = {};
    for (const p of res.data.Ok) map[p.id] = p.name;
    return map;
  }
  throw new Error("Failed to fetch players");
}

async function fetchBrackets(season) {
  const url = `${API_ROOT}/season/${season}/brackets`;
  const res = await axios.get(url);
  if (res.data && res.data.Ok) {
    const map = {};
    for (const b of res.data.Ok) map[b.id] = b.name;
    return map;
  }
  throw new Error("Failed to fetch brackets");
}

// Main logic
async function processRaces() {
  try {
    const races = await fetchScheduledRaces(config.seasonNumber);
    const now = Math.floor(Date.now() / 1000);
    // use a set for OpTiMiZaTiOn (a list would be fine at this cardinality realistically)
    let seen = new Set(state.seen_ids);
    const newRaces = races.filter(
      (r) =>
        !seen.has(r.id) &&
        r.state === "Scheduled" &&
        r.scheduled_for &&
        r.scheduled_for >= now
    );
    if (!newRaces.length) {
      return;
    }

    // Gather all player and bracket IDs
    const playerIds = Array.from(
      new Set(newRaces.flatMap((r) => [r.player_1_id, r.player_2_id]))
    );
    const [playerMap, bracketMap] = await Promise.all([
      fetchPlayers(playerIds),
      fetchBrackets(config.seasonNumber),
    ]);

    // Prepare Google Sheets client
    const sheets = await getSheetsClient();
    const sheetId = config.spreadsheetId;
    const sheetName = config.sheetName;
    const inputRow = config.sheetInputRow;

    // Resolve the numeric sheetId from the sheet name
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
    });
    const sheetMeta = spreadsheet.data.sheets.find(
      (s) => s.properties.title === sheetName
    );
    if (!sheetMeta) {
      console.error(
        `[${new Date().toISOString()}] Sheet name '${sheetName}' not found in spreadsheet.`
      );
      return;
    }
    const sheetIdNum = sheetMeta.properties.sheetId;

    for (const race of newRaces.sort((a, b) => a.id - b.id)) {
      if (!race.scheduled_for || race.scheduled_for < now) {
        continue;
      }
      const player1 =
        playerMap[race.player_1_id] || `Player ${race.player_1_id}`;
      const player2 =
        playerMap[race.player_2_id] || `Player ${race.player_2_id}`;
      const bracket =
        bracketMap[race.bracket_id] || `Bracket ${race.bracket_id}`;
      const eventString = `${config.eventName}: ${bracket} - ${player1} vs. ${player2}`;
      const estimate = config.runEstimate;
      const runnerCount = config.runnerCount;
      const dateUTC = race.scheduled_for
        ? new Date(race.scheduled_for * 1000)
        : null;
      const dateUTCString = dateUTC ? formatMMDDYYYY_HHMMSS(dateUTC) : "";

      // Prepare row values with formulas for columns B, C, D
      const rowNum = inputRow; // Always inserting at inputRow
      const isDST = dateUTC ? isETDST(dateUTC) : false;
      const offsetCell = isDST ? "Sheet2!$A$2" : "Sheet2!$A$1";
      const row = [
        dateUTCString, // A: UTC datetime (value)
        `=IF(A${rowNum}="", "", TEXT(A${rowNum}, "ddd"))`, // B: Day in UTC (formula)
        `=IF(A${rowNum}="", "", A${rowNum}-${offsetCell})`, // C: ET time (formula, DST/EST aware)
        `=IF(C${rowNum}="", "", TEXT(C${rowNum}, "ddd"))`, // D: Day in ET (formula)
        eventString, // E: Event string
        estimate, // F: Estimate
        runnerCount, // G: Runner count
        "", // H
        "", // I
        "", // J
        "", // K
        "", // L
        "", // M
        "", // N
        "", // O
        "", // P
        "", // Q
      ];

      // Insert row at inputRow (row 4, 0-based index is 3)
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [
            {
              insertDimension: {
                range: {
                  sheetId: sheetIdNum,
                  dimension: "ROWS",
                  startIndex: inputRow - 1,
                  endIndex: inputRow,
                },
                inheritFromBefore: false,
              },
            },
          ],
        },
      });
      // Write values
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${sheetName}!A${inputRow}:Q${inputRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [row] },
      });
      // Update state
      state.seen_ids.push(race.id);
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    }

    // Auto-sort the signup sheet after processing all races
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [
          {
            sortRange: {
              range: {
                sheetId: sheetIdNum,
                startRowIndex: inputRow - 1, // 0-based
                endRowIndex: inputRow - 1 + 75, // sort 75 rows
                startColumnIndex: 0,
                endColumnIndex: 17, // columns A-Q
              },
              sortSpecs: [
                {
                  dimensionIndex: 0, // column A
                  sortOrder: "ASCENDING",
                },
              ],
            },
          },
        ],
      },
    });
  } catch (err) {
    console.error(
      `[${new Date().toISOString()}] Error processing races:`,
      err.message
    );
  }
}

// Run every 10 minutes
console.log(`[${new Date().toISOString()}] Bot started up.`);
processRaces();
setInterval(processRaces, 10 * 60 * 1000);
