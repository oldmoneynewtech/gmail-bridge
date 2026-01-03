const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SWEEP_SECRET = process.env.SWEEP_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
let savedTokens = null;
// ✅ If a refresh token exists, auto-auth on startup (no manual /oauth/authorize needed)
if (GOOGLE_REFRESH_TOKEN) {
  savedTokens = { refresh_token: GOOGLE_REFRESH_TOKEN };
  oauth2Client.setCredentials(savedTokens);
}


const REDIRECT_URI = `${BASE_URL}/oauth/callback`;

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

// ⚠️ v1: tokens stored in memory. Render free may restart => re-auth sometimes.
let savedTokens = null;

function requireAuthed(req, res, next) {
  if (!savedTokens) return res.status(401).json({ error: "Not authorized. Visit /oauth/authorize" });
  oauth2Client.setCredentials(savedTokens);
  next();
}

function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function gmailClient() {
  return google.gmail({ version: "v1", auth: oauth2Client });
}

function headerValue(headers, name) {
  const h = (headers || []).find(x => (x.name || "").toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

app.get("/health", (req, res) => res.json({ ok: true, authed: !!savedTokens }));

// OAuth start
app.get("/oauth/authorize", (req, res) => {
  const scopes = [
    // ✅ read + draft + label/mark processed
    "https://www.googleapis.com/auth/gmail.modify"
  ];

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes
  });

  res.redirect(url);
});

// OAuth callback
app.get("/oauth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing ?code=");

    const { tokens } = await oauth2Client.getToken(code);
    savedTokens = tokens;
    if (tokens.refresh_token) {
  console.log("NEW_REFRESH_TOKEN:", tokens.refresh_token);
}

    res.send("OAuth success. Tokens saved. Check /health (authed=true).");
  } catch (err) {
    console.error(err);
    res.status(500).send("OAuth callback failed. Check server logs.");
  }
});

// Create a NEW draft (not in-thread)
app.post("/draft", requireAuthed, async (req, res) => {
  try {
    const { to, subject, body, cc, bcc } = req.body || {};
    if (!to || !subject || !body) return res.status(400).json({ error: "Missing to, subject, body" });

    const gmail = await gmailClient();

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
      requestBody: { message: { raw } }
    });

    res.json({ ok: true, draftId: draft.data.id, messageId: draft.data.message?.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Draft creation failed. Check logs." });
  }
});

// ✅ List unread Primary emails (metadata only)
app.get("/unread-primary", requireAuthed, async (req, res) => {
  try {
    const max = Math.min(parseInt(req.query.max || "10", 10), 25);

    // Primary + unread; skip common junk patterns
    const q = [
      "is:unread",
      "category:primary",
      "-from:noreply",
      "-from:no-reply",
      "-subject:(receipt OR invoice OR confirmation OR unsubscribe)"
    ].join(" ");

    const gmail = await gmailClient();

    const list = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults: max
    });

    const ids = (list.data.messages || []).map(m => m.id);
    if (ids.length === 0) return res.json({ ok: true, messages: [] });

    // Fetch metadata for each message
    const out = [];
    for (const id of ids) {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date", "Message-ID", "References"]
      });

      const headers = msg.data.payload?.headers || [];
      out.push({
        id: msg.data.id,
        threadId: msg.data.threadId,
        snippet: msg.data.snippet || "",
        from: headerValue(headers, "From"),
        subject: headerValue(headers, "Subject"),
        date: headerValue(headers, "Date")
      });
    }

    res.json({ ok: true, query: q, messages: out });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list unread primary. Check logs." });
  }
});

// ✅ Create a reply draft IN THE SAME THREAD
app.post("/reply-draft", requireAuthed, async (req, res) => {
  try {
    const { messageId, body } = req.body || {};
    if (!messageId || !body) return res.status(400).json({ error: "Missing messageId, body" });

    const gmail = await gmailClient();

    // Get the original email metadata
    const original = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["From", "To", "Reply-To", "Subject", "Message-ID", "References"]
    });

    const headers = original.data.payload?.headers || [];
    const threadId = original.data.threadId;

    const subject = headerValue(headers, "Subject") || "";
    const replyTo = headerValue(headers, "Reply-To");
    const from = headerValue(headers, "From");
    const toAddr = replyTo || from; // basic default
    const msgIdHeader = headerValue(headers, "Message-ID");
    const refsHeader = headerValue(headers, "References");

    const replySubject = subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`;

    // RFC822 reply headers
    const replyHeaders = [];
    replyHeaders.push(`To: ${toAddr}`);
    replyHeaders.push(`Subject: ${replySubject}`);
    replyHeaders.push("MIME-Version: 1.0");
    replyHeaders.push('Content-Type: text/plain; charset="UTF-8"');

    if (msgIdHeader) {
      replyHeaders.push(`In-Reply-To: ${msgIdHeader}`);
      const refs = refsHeader ? `${refsHeader} ${msgIdHeader}` : msgIdHeader;
      replyHeaders.push(`References: ${refs}`);
    }

    const rawMessage = `${replyHeaders.join("\r\n")}\r\n\r\n${body}\r\n`;
    const raw = base64UrlEncode(rawMessage);

    const draft = await gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          raw,
          threadId
        }
      }
    });

    res.json({ ok: true, draftId: draft.data.id, threadId, repliedToMessageId: messageId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Reply draft failed. Check logs." });
  }
});

// --- Automation: run a sweep that drafts replies ---
// Called by scheduler (GitHub Actions). Draft-only; does NOT send.
app.post("/run-sweep", requireAuthed, async (req, res) => {
  try {
    const auth = req.headers["authorization"] || "";
    const expected = `Bearer ${SWEEP_SECRET}`;
    if (!SWEEP_SECRET || auth !== expected) return res.status(401).json({ error: "Unauthorized" });
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY env var" });

    const max = Math.min(parseInt(req.query.max || "10", 10), 25);

    // 1) Get candidates
    const listResp = await fetch(`${BASE_URL}/unread-primary?max=${max}`, {
      headers: { Authorization: auth }
    });
    const listJson = await listResp.json();
    const messages = listJson.messages || [];

    const gmail = await gmailClient();

    // Ensure label exists
    const labelName = "AI-Drafted";
    let labelId = null;
    const labels = await gmail.users.labels.list({ userId: "me" });
    const existing = (labels.data.labels || []).find(l => l.name === labelName);
    if (existing) labelId = existing.id;
    else {
      const created = await gmail.users.labels.create({
        userId: "me",
        requestBody: { name: labelName, labelListVisibility: "labelShow", messageListVisibility: "show" }
      });
      labelId = created.data.id;
    }

    const drafted = [];

    for (const m of messages) {
      // 2) Pull full message (snippet is often enough for v1; you can upgrade later)
      const msg = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
      const snippet = msg.data.snippet || m.snippet || "";
      const headers = msg.data.payload?.headers || [];
      const from = headerValue(headers, "From");
      const subject = headerValue(headers, "Subject");

      // 3) Generate reply text via OpenAI Responses API (server-side)
      // Keep it conservative: short, professional, ask clarifying question if needed.
      const prompt = `
You are Nathan's email assistant. Draft a reply only if a reply is needed.
If not needed, output exactly: NO_REPLY

Email:
From: ${from}
Subject: ${subject}
Snippet: ${snippet}

Reply rules:
- Be concise, professional, helpful.
- If it's unclear, ask 1 clarifying question.
- Never mention AI.
- Do not promise anything untrue.
- End with a simple signature: "— Nathan"
`;

      const aiResp = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-5", // pick any model you have access to
          input: prompt
        })
      });

      const aiJson = await aiResp.json();
      const text =
        aiJson.output?.[0]?.content?.map(c => c.text).join("") ||
        aiJson.output_text ||
        "";

      const replyText = (text || "").trim();

      if (!replyText || replyText === "NO_REPLY") continue;

      // 4) Create reply draft in-thread
      const rd = await fetch(`${BASE_URL}/reply-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({ messageId: m.id, body: replyText })
      });
      const rdJson = await rd.json();
      if (!rdJson.ok) continue;

      // 5) Label the thread/message so you can review
      await gmail.users.messages.modify({
        userId: "me",
        id: m.id,
        requestBody: { addLabelIds: [labelId] }
      });

      drafted.push({ messageId: m.id, draftId: rdJson.draftId });
    }

    res.json({ ok: true, draftedCount: drafted.length, drafted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Sweep failed. Check logs." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
;
