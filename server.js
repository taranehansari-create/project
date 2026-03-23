import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
//  ANALYSIS PROMPT
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert calendar analyst. Your job is to read a person's schedule and surface specific, actionable issues they may not have noticed.

You will analyze any schedule format: free text, bullet lists, pasted from a calendar, or structured data.

Detect the following issues:

1. **CONFLICTS** — Events that overlap in time, back-to-back meetings with no buffer, or double-bookings.

2. **MISSING INFO** — Specifically:
   - Virtual/phone calls or "zoom/meet/teams/video" meetings that have no link, dial-in, or conferencing info
   - Meetings described as "in-person", "conference room", "office", or requiring a physical space but with no room name or booking reference
   - Events with vague or missing titles that could cause confusion

3. **TOPIC CLUSTERS** — Groups of meetings that share the same project, client, team, or theme but are scattered across the week. Consolidating them into blocks would reduce context-switching and save time.

Return ONLY valid JSON (no markdown, no explanation, no code fences) matching this exact schema:

{
  "events": [
    {
      "id": 1,
      "title": "string",
      "date": "string (e.g. Monday, Tue 14th, 2024-03-25)",
      "startTime": "HH:MM",
      "endTime": "HH:MM",
      "type": "call" | "meeting" | "focus" | "interview" | "review" | "1:1" | "other",
      "isVirtual": true | false,
      "hasVideoLink": true | false,
      "hasRoom": true | false,
      "attendees": ["name1", "name2"],
      "rawText": "original text snippet"
    }
  ],
  "conflicts": [
    {
      "event1Id": 1,
      "event2Id": 2,
      "overlapMinutes": 30,
      "severity": "hard" | "soft",
      "description": "brief human-readable description",
      "impact": "why this matters"
    }
  ],
  "missingInfo": [
    {
      "eventId": 1,
      "issueType": "no_video_link" | "no_room" | "no_dial_in" | "vague_title" | "no_agenda",
      "description": "specific description of what is missing",
      "suggestion": "concrete fix suggestion"
    }
  ],
  "topicClusters": [
    {
      "clusterName": "string (e.g. 'Q2 Planning', 'Engineering Syncs', 'Client: Acme Corp')",
      "theme": "string (short description of what these share)",
      "eventIds": [1, 3, 5],
      "currentPattern": "string describing how they are currently spread out",
      "suggestedBlock": "string describing when/how to consolidate",
      "benefit": "string explaining the concrete benefit"
    }
  ],
  "healthScore": 85,
  "healthLabel": "Excellent" | "Good" | "Fair" | "Poor",
  "summary": "2-3 sentence overview of the calendar's biggest issues",
  "recommendations": [
    "Specific recommendation 1",
    "Specific recommendation 2",
    "Specific recommendation 3"
  ]
}

Rules:
- Be specific and concrete. "Team standup at 9am overlaps with your 1:1 with Sarah at 9am" is better than "two events overlap".
- Only flag missing video links if the meeting is clearly virtual (has zoom/meet/teams/call in the name or description, or has a clearly remote attendee context).
- Only flag missing rooms if the meeting is clearly in-person.
- Topic clusters should have at least 2 events each.
- Health score: 90-100 = Excellent, 70-89 = Good, 50-69 = Fair, 0-49 = Poor.
- If you can't determine a time or date, make a best guess or use "Unknown".
- Always return valid JSON. Never include markdown or prose outside the JSON.`;

// ─────────────────────────────────────────────────────────────────────────────
//  API ENDPOINT
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/analyze', async (req, res) => {
  const { schedule } = req.body;

  if (!schedule?.trim()) {
    return res.status(400).json({ error: 'No schedule provided.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const stream = client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Analyze this calendar schedule and return JSON:\n\n${schedule.trim()}`,
        },
      ],
    });

    let fullText = '';

    stream.on('text', (delta) => {
      fullText += delta;
      send({ type: 'delta', text: delta });
    });

    const finalMsg = await stream.finalMessage();

    // Extract JSON from the response (strip any accidental markdown fences)
    const jsonMatch = fullText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      send({ type: 'error', message: 'Could not parse analysis response. Try rephrasing your schedule.' });
      return res.end();
    }

    try {
      const analysis = JSON.parse(jsonMatch[0]);
      send({ type: 'done', analysis });
    } catch (parseErr) {
      send({ type: 'error', message: 'JSON parse error: ' + parseErr.message });
    }

    res.end();
  } catch (err) {
    const msg = err?.message || 'Unknown error';
    if (!res.headersSent) {
      res.status(500).json({ error: msg });
    } else {
      send({ type: 'error', message: msg });
      res.end();
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Calendar Analyzer → http://localhost:${PORT}\n`);
});
