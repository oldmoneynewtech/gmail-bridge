const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.warn("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in environment variables.");
}

// Redirect URI must match what you set in Google Cloud OAuth Client
const REDIRECT_URI = `${BASE_URL}/oauth/callback`;

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

// ✅ v1 storage (simple): tokens in memory.
// NOTE: Render free instances can restart; this will require re-auth later.
let savedTokens = null;

app.get("/health", (req, res) => {
  res.json({ ok: true, authed: !!savedTokens });
});

// 1) Start OAuth: send you to Google login/consent
app.get("/oauth/authorize", (req, res) => {
  const scopes = [
    // Draft-only permission
    "https://www.googleapis.com/auth/gmail.compose"
  ];

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline", // requests refresh token
    prompt: "consent",      // forces refresh token issuance in many cases
    scope: scopes
  });

  res.redirect(url);
});

// 2) OAuth callback: Google redirects here with ?code=...
app.get("/oauth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing ?code= in callback URL.");

    const { tokens } = await oauth2Client.getToken(code);
    savedTokens = tokens;

    res.send(
      "OAuth success. Tokens saved (in memory). You can now POST /draft. " +
      "Check /health to confirm authed=true."
    );
  } catch (err) {
    console.error(err);
    res.status(500).send("OAuth callback failed. Check server logs.");
  }
});

// Helper: base64url encode for Gmail raw message
function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// 3) Create a Gmail draft
app.post("/draft", async (req, res) => {
  try {
    if (!savedTokens) {
      return res.status(401).json({
        error: "Not authorized. Visit /oauth/authorize first."
      });
    }

    const { to, subject, body, cc, bcc } = req.body || {};
    if (!to || !subject || !body) {
      return res.status(400).json({
        error: "Missing required fields: to, subject, body"
      });
    }

    oauth2Client.setCredentials(savedTokens);

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const headers = [];
    headers.push(`To: ${to}`);
    if (cc) headers.push(`Cc: ${cc}`);
    if (bcc) headers.push(`Bcc: ${bcc}`);
    headers.push(`Subject: ${subject}`);
    headers.push("MIME-Version: 1.0");
    headers.push('Content-Type: text/plain; charset="UTF-8"');

    const rawMessage = `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
    const raw = base64UrlEncode(rawMessage);

    const draft = await gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: { raw }
      }
    });

    res.json({
      ok: true,
      draftId: draft.data.id,
      messageId: draft.data.message && draft.data.message.id
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Draft creation failed. Check logs." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
