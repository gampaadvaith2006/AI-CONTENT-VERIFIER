const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const axios = require("axios");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ==========================================
// CONFIGURATION
// ==========================================

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

const AI_MODELS = [
  "openrouter/free",
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
];

// ==========================================
// MIDDLEWARE
// ==========================================

app.use(
  cors({
    origin: ["http://localhost:5173", "http://localhost:5174"],
  })
);

app.use(express.json({ limit: "1mb" }));

// ==========================================
// HEALTH CHECK
// ==========================================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Backend is healthy",
  });
});

// ==========================================
// HELPERS
// ==========================================

function normalizeVerdict(verdict) {
  if (!verdict) return "UNVERIFIED";

  const value = String(verdict).trim().toUpperCase();

  if (
    value === "REAL" ||
    value === "TRUE" ||
    value === "VERIFIED" ||
    value === "SUPPORTED" ||
    value === "CONFIRMED"
  ) {
    return "REAL";
  }

  if (
    value === "FAKE" ||
    value === "FALSE" ||
    value === "MISLEADING" ||
    value === "CONTRADICTED" ||
    value === "DISPROVEN"
  ) {
    return "FAKE";
  }

  return "UNVERIFIED";
}

function normalizeAssessment(assessment) {
  if (!assessment) return "UNVERIFIED";

  const value = String(assessment).trim().toUpperCase();

  if (
    value === "REAL" ||
    value === "TRUE" ||
    value === "VERIFIED" ||
    value === "SUPPORTED" ||
    value === "CONFIRMED"
  ) {
    return "REAL";
  }

  if (
    value === "FAKE" ||
    value === "FALSE" ||
    value === "MISLEADING" ||
    value === "CONTRADICTED" ||
    value === "DISPROVEN"
  ) {
    return "FAKE";
  }

  return "UNVERIFIED";
}

function cleanAIResponse(content) {
  let cleaned = String(content || "").trim();

  // Remove markdown code fences
  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Find the JSON object if extra text was returned
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  return cleaned;
}

// ==========================================
// TAVILY WEB SEARCH
// ==========================================

async function searchWeb(query) {
  console.log("\nSearching the web with Tavily...");
  console.log("Query:", query);

  if (!process.env.TAVILY_API_KEY) {
    console.log("TAVILY_API_KEY is missing.");
    return [];
  }

  try {
    const response = await axios.post(
      "https://api.tavily.com/search",
      {
        api_key: process.env.TAVILY_API_KEY,
        query: query,
        search_depth: "advanced",
        topic: "general",
        max_results: 8,
        include_answer: false,
        include_raw_content: false,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    const results = Array.isArray(response.data?.results)
      ? response.data.results
      : [];

    console.log(`Tavily returned ${results.length} source(s).`);

    return results.map((item) => ({
      title: item.title || "Untitled source",
      url: item.url || "",
      content: item.content || "",
      score: item.score || 0,
    }));
  } catch (error) {
    console.error(
      "Tavily error:",
      error.response?.data || error.message
    );

    return [];
  }
}

// ==========================================
// OPENROUTER AI CALL
// ==========================================

async function callAI(userContent) {
  let lastError = null;

  for (const model of AI_MODELS) {
    try {
      console.log(`\nTrying OpenRouter model: ${model}`);

      const completion = await client.chat.completions.create({
        model: model,

        messages: [
          {
            role: "system",
            content: `
You are TruthLens AI, a careful fact-checking assistant.

Your job is to evaluate the EXACT claim submitted by the user.

IMPORTANT RULES:

1. Evaluate the exact wording of the submitted claim.
2. Do NOT mark a claim REAL just because a related topic is real.
3. Every important part of the claim must be supported before calling the overall claim REAL.
4. If an important part of the claim is contradicted by reliable evidence, classify the overall claim as FAKE.
5. If reliable evidence is insufficient, classify it as UNVERIFIED.
6. Do not invent facts, sources, quotations, dates, laws, regulations, statistics, or URLs.
7. Prefer authoritative primary sources:
   - Government websites
   - Regulatory authorities
   - Official organizations
   - Official company statements
   - Original research or documents
8. For Indian financial/banking claims, give strong preference to:
   - RBI
   - Government of India
   - Ministry of Finance
   - SEBI
   - NPCI
   - Official bank websites
9. News organizations can be useful secondary sources.
10. Social-media posts, blogs, forums and low-quality websites should be treated as weak evidence.
11. A source discussing a similar topic is NOT sufficient evidence for the exact claim.
12. Pay close attention to words such as:
   - unlimited
   - always
   - never
   - guaranteed
   - completely
   - all
   - every
   - officially
   - new rule
13. If the evidence contradicts an important absolute word such as "unlimited", the claim should not be classified as REAL.
14. Do not confuse "related to the claim" with "proof of the claim".
15. When sources disagree, explain the disagreement and use UNVERIFIED when the evidence cannot establish the claim reliably.
16. Confidence should reflect the quality and consistency of the evidence, not simply how certain the language sounds.
17. Do not use political persuasion or political opinions. Report factual evidence neutrally.

VERDICT DEFINITIONS:

REAL:
The exact claim is supported by strong and relevant evidence.

FAKE:
The exact claim is contradicted by strong and relevant evidence.

UNVERIFIED:
There is not enough reliable evidence to establish whether the exact claim is true or false.

OUTPUT REQUIREMENT:

Return ONLY valid JSON.

Use exactly this structure:

{
  "verdict": "REAL | FAKE | UNVERIFIED",
  "confidence": 0,
  "risk": "LOW | MEDIUM | HIGH",
  "summary": "Short explanation of the exact claim and evidence.",
  "key_claims": [
    {
      "claim": "Specific part of the submitted claim",
      "assessment": "REAL | FAKE | UNVERIFIED",
      "reason": "Evidence-based explanation"
    }
  ],
  "red_flags": [
    "Potential problem with the claim or evidence"
  ],
  "sources_used": [
    {
      "title": "Source title",
      "url": "https://example.com",
      "relevance": "Why this source is relevant"
    }
  ]
}

ADDITIONAL REQUIREMENTS:

- confidence must be an integer from 0 to 100.
- Use REAL, FAKE or UNVERIFIED only.
- Do not put markdown around the JSON.
- Do not add commentary outside the JSON.
- Do not invent URLs.
- If a source URL is provided, preserve that URL exactly.
`,
          },
          {
            role: "user",
            content: userContent,
          },
        ],

        temperature: 0.1,

        max_tokens: 2500,
      });

      const content =
        completion?.choices?.[0]?.message?.content || "";

      if (!content) {
        throw new Error("OpenRouter returned an empty response.");
      }

      console.log(`OpenRouter model succeeded: ${model}`);

      return content;
    } catch (error) {
      lastError = error;

      const status = error?.status || error?.response?.status;
      const message =
        error?.message ||
        error?.response?.data?.error?.message ||
        "Unknown OpenRouter error";

      console.error("\nOpenRouter model failed:", model);
      console.error("Status:", status);
      console.error("Message:", message);

      if (error?.response?.data) {
        console.error(
          "Response:",
          JSON.stringify(error.response.data, null, 2)
        );
      }

      // Try the next model for rate limits
      if (status === 429) {
        console.log("Rate limited. Trying next model...");
        continue;
      }

      // Also try another model for temporary server errors
      if (status >= 500) {
        console.log("OpenRouter server error. Trying next model...");
        continue;
      }

      // Try next model rather than immediately failing
      continue;
    }
  }

  throw lastError || new Error("All AI models failed.");
}

// ==========================================
// ANALYZE ENDPOINT
// ==========================================

app.post("/api/analyze", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();

    if (!text) {
      return res.status(400).json({
        success: false,
        message: "Please enter a claim or news article.",
      });
    }

    if (text.length > 5000) {
      return res.status(400).json({
        success: false,
        message: "Content must be 5000 characters or less.",
      });
    }

    // ======================================
    // WEB SEARCH
    // ======================================

    const searchResults = await searchWeb(text);

    // ======================================
    // FORMAT WEB EVIDENCE
    // ======================================

    let evidenceText = "";

    if (searchResults.length > 0) {
      evidenceText = searchResults
        .map(
          (source, index) => `
SOURCE ${index + 1}

Title:
${source.title}

URL:
${source.url}

Search relevance score:
${source.score}

Content:
${source.content}
`
        )
        .join("\n-------------------------\n");
    } else {
      evidenceText =
        "No web search results were available. Do not assume the claim is true.";
    }

    // ======================================
    // AI INPUT
    // ======================================

    const aiInput = `
EXACT CLAIM SUBMITTED BY USER:

"${text}"

IMPORTANT:
You must evaluate the exact claim above.

Do not replace it with a broader or related claim.

For example:

If the user says:
"RBI introduced a rule allowing unlimited cash withdrawals."

And the sources only show:
"RBI changed ATM fees or reporting requirements."

That does NOT prove the user's exact claim.

The word "unlimited" must be independently supported.

WEB EVIDENCE:

${evidenceText}

Now determine whether the EXACT submitted claim is:

REAL
FAKE
or
UNVERIFIED

Return ONLY the required JSON.
`;

    console.log("\nSending claim + web evidence to OpenRouter...");

    // ======================================
    // CALL AI
    // ======================================

    const rawAIResponse = await callAI(aiInput);

    console.log("\n========== RAW AI RESPONSE ==========");
    console.log(rawAIResponse);
    console.log("=====================================");

    // ======================================
    // CLEAN RESPONSE
    // ======================================

    const cleanedResponse = cleanAIResponse(rawAIResponse);

    console.log("\n========== CLEANED AI RESPONSE ==========");
    console.log(cleanedResponse);
    console.log("=========================================");

    let analysis;

    try {
      analysis = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error("JSON parsing failed:", parseError);

      return res.status(500).json({
        success: false,
        message: "The AI returned an invalid response. Please try again.",
      });
    }

    // ======================================
    // NORMALIZE AI RESULT
    // ======================================

    analysis.verdict = normalizeVerdict(analysis.verdict);

    if (typeof analysis.confidence !== "number") {
      analysis.confidence = parseInt(analysis.confidence, 10);
    }

    if (
      Number.isNaN(analysis.confidence) ||
      analysis.confidence < 0 ||
      analysis.confidence > 100
    ) {
      analysis.confidence = 50;
    }

    if (!["LOW", "MEDIUM", "HIGH"].includes(analysis.risk)) {
      analysis.risk = "MEDIUM";
    }

    if (!Array.isArray(analysis.key_claims)) {
      analysis.key_claims = [];
    }

    if (!Array.isArray(analysis.red_flags)) {
      analysis.red_flags = [];
    }

    if (!Array.isArray(analysis.sources_used)) {
      analysis.sources_used = [];
    }

    analysis.key_claims = analysis.key_claims.map((item) => ({
      claim: item?.claim || "",
      assessment: normalizeAssessment(item?.assessment),
      reason: item?.reason || "",
    }));

    // ======================================
    // FALLBACK SOURCES
    // ======================================

    if (
      analysis.sources_used.length === 0 &&
      searchResults.length > 0
    ) {
      analysis.sources_used = searchResults
        .slice(0, 5)
        .map((source) => ({
          title: source.title,
          url: source.url,
          relevance:
            "Web search result used as supporting evidence.",
        }));
    }

    // ======================================
    // FINAL LOG
    // ======================================

    console.log("\n========== FINAL ANALYSIS ==========");
    console.log(JSON.stringify(analysis, null, 2));
    console.log("====================================");

    return res.json({
      success: true,
      data: analysis,
    });
  } catch (error) {
    console.error("\n========== ANALYSIS ERROR ==========");
    console.error(error);
    console.error("====================================");

    const status = error?.status || error?.response?.status;

    if (status === 401) {
      return res.status(401).json({
        success: false,
        message:
          "OpenRouter authentication failed. Check your API key.",
      });
    }

    if (status === 429) {
      return res.status(429).json({
        success: false,
        message:
          "All available OpenRouter models are currently rate limited. Please try again shortly.",
      });
    }

    return res.status(500).json({
      success: false,
      message:
        "The AI service is temporarily unavailable. Please try again.",
    });
  }
});

// ==========================================
// START SERVER
// ==========================================

const server = app.listen(PORT, () => {
  console.log(`
======================================
       TruthLens AI Backend
======================================
Server running on http://localhost:${PORT}
Health check: http://localhost:${PORT}/api/health
Web verification: Tavily + OpenRouter
======================================
`);
});

server.on("error", (error) => {
  console.error("Server error:", error);
});