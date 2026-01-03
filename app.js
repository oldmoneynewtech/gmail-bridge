const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

// -------------------- ENV --------------------
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN; // persist auth
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;             // used by /run-sweep
const SWEEP_SECRET = process.env.SWEEP_SECRET;                 // used by /run-sweep auth

const REDIRECT_URI = `${BASE_URL}/oauth/callback`;

// -------------------- GOOGLE OAUTH CLIENT --------------------
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

// -------------------- TOKEN STATE --------------------
// We persist refresh_token in Render env; access tokens are fetched automatically as needed.
let savedTokens = null;

if (GOOGLE_REFRESH_TOKEN) {
  savedTokens = { refresh_token: GOOGLE_REFRESH_TOKEN };
  oauth2Client.setCredentials(savedTokens);
}

function requireAuthed(req, res, next) {
  if (!savedTokens || !savedTokens.refresh_token) {
    return res.status(401).json({ error: "Not authorized. Visit /oauth/authorize" });
  }
  oauth2Client.setCredentials(savedTokens);
  next();
}

// -------------------- HELPERS --------------------
function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function headerValue(headers, name) {
  const h = (headers || []).find(
    (x) => (x.name || "").toLowerCase() === name.toLowerCase()
  );
  return h?.value || "";
}

async function gmailClient() {
  return google.gmail({ version: "v1", auth: oauth2Client });
}

// -------------------- HEALTH --------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, authed: !!(savedTokens && savedTokens.refresh_token) });
});

// -------------------- OAUTH --------------------
app.get("/oauth/authorize", (req, res) => {
  const scopes = ["https://www.googleapis.com/auth/gmail.modify"];

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
  });

  res.redirect(url);
});

app.get("/oauth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing ?code=");

    const { tokens } = await oauth2Client.getToken(code);

    // Keep refresh token if Google provides it; otherwise preserve existing one.
    const refresh = tokens.refresh_token || savedTokens?.refresh_token;

    savedTokens = {
      ...tokens,
      refresh_token: refresh,
    };

    oauth2Client.setCredentials(savedTokens);

    if (tokens.refresh_token) {
      console.log("NEW_REFRESH_TOKEN:", tokens.refresh_token);
    }

    res.send("OAuth success. Tokens saved. Check /health (authed=true).");
  } catch (err) {
    console.error(err);
    res.status(500).send("OAuth callback failed. Check server logs.");
  }
});

// -------------------- DRAFT (new thread) --------------------
app.post("/draft", requireAuthed, async (req, res) => {
  try {
    const { to, subject, body, cc, bcc } = req.body || {};
    if (!to || !subject || !body) {
      return res.status(400).json({ error: "Missing required fields: to, subject, body" });
    }

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
      requestBody: { message: { raw } },
    });

    res.json({ ok: true, draftId: draft.data.id, messageId: draft.data.message?.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Draft creation failed. Check logs." });
  }
});

// -------------------- LIST UNREAD PRIMARY --------------------
app.get("/unread-primary", requireAuthed, async (req, res) => {
  try {
    const max = Math.min(parseInt(req.query.max || "10", 10), 25);

    // Skip anything already processed + common junk
    const q = [
      "is:unread",
      "category:primary",
      "-label:AI-Drafted",
      "-from:noreply",
      "-from:no-reply",
      "-subject:(receipt OR invoice OR confirmation OR unsubscribe)",
    ].join(" ");

    const gmail = await gmailClient();

    const list = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults: max,
    });

    const ids = (list.data.messages || []).map((m) => m.id);
    if (ids.length === 0) return res.json({ ok: true, query: q, messages: [] });

    const out = [];
    for (const id of ids) {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date", "Message-ID", "References"],
      });

      const headers = msg.data.payload?.headers || [];
      out.push({
        id: msg.data.id,
        threadId: msg.data.threadId,
        snippet: msg.data.snippet || "",
        from: headerValue(headers, "From"),
        subject: headerValue(headers, "Subject"),
        date: headerValue(headers, "Date"),
      });
    }

    res.json({ ok: true, query: q, messages: out });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list unread primary. Check logs." });
  }
});

// -------------------- REPLY DRAFT (same thread) --------------------
app.post("/reply-draft", requireAuthed, async (req, res) => {
  try {
    const { messageId, body } = req.body || {};
    if (!messageId || !body) {
      return res.status(400).json({ error: "Missing required fields: messageId, body" });
    }

    const gmail = await gmailClient();

    const original = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["From", "To", "Reply-To", "Subject", "Message-ID", "References"],
    });

    const headers = original.data.payload?.headers || [];
    const threadId = original.data.threadId;

    const subject = headerValue(headers, "Subject") || "";
    const replyTo = headerValue(headers, "Reply-To");
    const from = headerValue(headers, "From");
    const toAddr = replyTo || from;
    const msgIdHeader = headerValue(headers, "Message-ID");
    const refsHeader = headerValue(headers, "References");

    const replySubject = subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`;

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
          threadId,
        },
      },
    });

    res.json({ ok: true, draftId: draft.data.id, threadId, repliedToMessageId: messageId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Reply draft failed. Check logs." });
  }
});

// -------------------- RUN SWEEP (automation) --------------------
app.post("/run-sweep", requireAuthed, async (req, res) => {
  try {
    const auth = req.headers["authorization"] || "";
    const expected = `Bearer ${SWEEP_SECRET}`;

    if (!SWEEP_SECRET || auth !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY env var" });
    }

    const max = Math.min(parseInt(req.query.max || "10", 10), 25);

    // 1) Get candidates
    const gmail = await gmailClient();
    const q = [
      "is:unread",
      "category:primary",
      "-label:AI-Drafted",
      "-from:noreply",
      "-from:no-reply",
      "-subject:(receipt OR invoice OR confirmation OR unsubscribe)",
    ].join(" ");

    const list = await gmail.users.messages.list({ userId: "me", q, maxResults: max });
    const ids = (list.data.messages || []).map((m) => m.id);

    // Ensure label exists
    const labelName = "AI-Drafted";
    let labelId = null;
    const labels = await gmail.users.labels.list({ userId: "me" });
    const existing = (labels.data.labels || []).find((l) => l.name === labelName);
    if (existing) labelId = existing.id;
    else {
      const created = await gmail.users.labels.create({
        userId: "me",
        requestBody: {
          name: labelName,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        },
      });
      labelId = created.data.id;
    }

    const drafted = [];

    for (const id of ids) {
      // 2) Pull message content (snippet for v1)
      const msg = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      const snippet = msg.data.snippet || "";
      const headers = msg.data.payload?.headers || [];
      const from = headerValue(headers, "From");
      const subject = headerValue(headers, "Subject");

      // 3) Generate reply via OpenAI Responses API
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
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5",
          input: prompt,
        }),
      });

      const aiJson = await aiResp.json();
      const text =
        aiJson.output?.[0]?.content?.map((c) => c.text).join("") ||
        aiJson.output_text ||
        "";

      const replyText = (text || "").trim();
      if (!replyText || replyText === "NO_REPLY") continue;

      // 4) Create reply draft in-thread
      const original = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Reply-To", "Subject", "Message-ID", "References"],
      });

      const oh = original.data.payload?.headers || [];
      const threadId = original.data.threadId;
      const origSubject = headerValue(oh, "Subject") || "";
      const replyTo = headerValue(oh, "Reply-To");
      const origFrom = headerValue(oh, "From");
      const toAddr = replyTo || origFrom;
      const msgIdHeader = headerValue(oh, "Message-ID");
      const refsHeader = headerValue(oh, "References");
      const replySubject = origSubject.toLowerCase().startsWith("re:") ? origSubject : `Re: ${origSubject}`;

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

      const rawMessage = `${replyHeaders.join("\r\n")}\r\n\r\n${replyText}\r\n`;
      const raw = base64UrlEncode(rawMessage);

      const draft = await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw, threadId } },
      });

      // 5) Label processed so we don't draft again
      await gmail.users.messages.modify({
        userId: "me",
        id,
        requestBody: { addLabelIds: [labelId] },
      });

      drafted.push({ messageId: id, draftId: draft.data.id });
    }

    res.json({ ok: true, draftedCount: drafted.length, drafted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Sweep failed. Check logs." });
  }
});

// -------------------- START --------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
