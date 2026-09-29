const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const axios = require("axios");

dotenv.config({ path: require("path").join(__dirname, ".env") });

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

  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  return cleaned;
}

// ==========================================
// SOURCE QUALITY HELPERS
// ==========================================

function getDomain(url) {
  try {
    return new URL(url).hostname
      .replace(/^www\./, "")
      .toLowerCase();
  } catch {
    return "";
  }
}

function getSourcePriority(url) {
  const domain = getDomain(url);

  // Highest priority: official regulators/government
  const highestPriority = [
    "rbi.org.in",
    "sebi.gov.in",
    "npci.org.in",
    "gov.in",
    "mof.gov.in",
    "finmin.nic.in",
  ];

  if (
    highestPriority.some(
      (officialDomain) =>
        domain === officialDomain ||
        domain.endsWith("." + officialDomain)
    )
  ) {
    return 100;
  }

  // Other official government sources
  const officialPriority = [
    "nic.in",
    "mygov.in",
    "pib.gov.in",
    "mca.gov.in",
    "incometax.gov.in",
    "gst.gov.in",
  ];

  if (
    officialPriority.some(
      (officialDomain) =>
        domain === officialDomain ||
        domain.endsWith("." + officialDomain)
    )
  ) {
    return 90;
  }

  // Established news organizations
  const newsPriority = [
    "reuters.com",
    "bbc.com",
    "bbc.co.uk",
    "thehindu.com",
    "indianexpress.com",
    "hindustantimes.com",
    "timesofindia.indiatimes.com",
    "ndtv.com",
    "moneycontrol.com",
    "economictimes.indiatimes.com",
    "livemint.com",
  ];

  if (
    newsPriority.some(
      (newsDomain) =>
        domain === newsDomain ||
        domain.endsWith("." + newsDomain)
    )
  ) {
    return 70;
  }

  // Weak sources
  const weakSources = [
    "facebook.com",
    "instagram.com",
    "linkedin.com",
    "x.com",
    "twitter.com",
    "reddit.com",
    "youtube.com",
  ];

  if (
    weakSources.some(
      (weakDomain) =>
        domain === weakDomain ||
        domain.endsWith("." + weakDomain)
    )
  ) {
    return 20;
  }

  // Unknown/other websites
  return 40;
}

// ==========================================
// TAVILY WEB SEARCH
// ==========================================

async function searchWeb(query) {
  console.log("\n========== WEB SEARCH ==========");
  console.log("Claim:", query);

  const searches = [
    query,
    `"${query}" site:rbi.org.in`,
    `"${query}" site:gov.in`,
    `"${query}" site:sebi.gov.in`
  ];

  let allResults = [];

  for (const searchQuery of searches) {
    try {
      console.log("Searching:", searchQuery);

      const response = await axios.post(
        "https://api.tavily.com/search",
        {
          api_key: process.env.TAVILY_API_KEY,
          query: searchQuery,
          search_depth: "advanced",
          topic: "general",
          max_results: 5
        },
        {
          headers: {
            "Content-Type": "application/json"
          }
        }
      );

      const results = response.data?.results || [];

      allResults.push(...results);
    } catch (error) {
      console.log(
        "Search failed:",
        error.response?.data || error.message
      );
    }
  }

  // Remove duplicate URLs
  const uniqueResults = [];

  for (const result of allResults) {
    if (
      result?.url &&
      !uniqueResults.some(item => item.url === result.url)
    ) {
      uniqueResults.push(result);
    }
  }

  const rankedResults = uniqueResults
    .map(result => ({
      title: result.title || "Untitled source",
      url: result.url,
      content: result.content || "",
      score: result.score || 0,
      sourcePriority: getSourcePriority(result.url)
    }))
    .sort((a, b) => {
      if (b.sourcePriority !== a.sourcePriority) {
        return b.sourcePriority - a.sourcePriority;
      }

      return b.score - a.score;
    });

  console.log("\n========== SOURCE RANKING ==========");

  rankedResults.slice(0, 10).forEach((source, index) => {
    console.log(
      `${index + 1}. ${getDomain(source.url)} | Priority: ${source.sourcePriority} | Score: ${source.score}`
    );
  });

  console.log("====================================\n");

  return rankedResults;
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
18. Do not prefer social-media sources over official or established news sources when better evidence is available.
19. Use the strongest available evidence in your reasoning.
20. The backend will independently determine the final source list. Do not invent URLs.

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
  "sources_used": []
}

ADDITIONAL REQUIREMENTS:

- confidence must be an integer from 0 to 100.
- Use REAL, FAKE or UNVERIFIED only.
- Do not put markdown around the JSON.
- Do not add commentary outside the JSON.
- Do not invent URLs.
- The sources_used field should be an empty array because the backend will build the final source list from verified Tavily results.
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

      if (status === 429) {
        console.log("Rate limited. Trying next model...");
        continue;
      }

      if (status >= 500) {
        console.log("OpenRouter server error. Trying next model...");
        continue;
      }

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

Source quality priority:
${source.sourcePriority}

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

IMPORTANT SOURCE RULE:

Use higher-quality sources when available.

Source quality priority:
100 = major regulator/government authority
90 = official government source
70 = established news organization
40 = other website
20 = social media

A social-media post must not be treated as stronger evidence than an official regulator or established news organization.

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

    analysis.key_claims = analysis.key_claims.map((item) => ({
      claim: item?.claim || "",
      assessment: normalizeAssessment(item?.assessment),
      reason: item?.reason || "",
    }));

    // ======================================
    // FORCE VERIFIED SOURCE LIST
    // ======================================
    //
    // IMPORTANT:
    // Do NOT trust the AI-generated sources_used.
    // Build this list directly from Tavily results.
    //
    // This prevents the AI from returning:
    // Instagram
    // LinkedIn
    // fabricated URLs
    // unrelated URLs
    //
    // when stronger search results are available.
    // ======================================

    analysis.sources_used = searchResults
      .slice(0, 5)
      .map((source) => ({
        title: source.title,
        url: source.url,
        relevance:
          source.sourcePriority >= 90
            ? "High-quality official or government source."
            : source.sourcePriority >= 70
            ? "Established news source relevant to the claim."
            : source.sourcePriority >= 40
            ? "Supporting web source relevant to the claim."
            : "Lower-quality source; used only when stronger sources were unavailable.",
      }));

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
