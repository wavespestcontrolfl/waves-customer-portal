/**
 * Intelligence Bar — Admin API Route
 * server/routes/admin-intelligence-bar.js
 *
 * POST /api/admin/intelligence-bar/query
 *   Takes a natural language prompt from the admin portal,
 *   sends it to Claude Opus 4.6 with business-aware tools,
 *   and returns structured results + actions.
 *
 * POST /api/admin/intelligence-bar/execute
 *   Executes a confirmed action (update, schedule, SMS send)
 *   that was previously proposed by the intelligence bar.
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { TOOLS, executeTool } = require('../services/intelligence-bar/tools');
const logger = require('../services/logger');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

router.use(adminAuthenticate, requireTechOrAdmin);

const MODEL = process.env.INTELLIGENCE_BAR_MODEL || 'claude-opus-4-6';
const MAX_TOOL_ROUNDS = 8;

const SYSTEM_PROMPT = `You are the Waves Intelligence Bar — a natural language command center for Waves Pest Control & Lawn Care's admin portal. You help the operator (owner/admin) query, analyze, and take action on their business data.

BUSINESS CONTEXT:
- Waves Pest Control & Lawn Care serves Southwest Florida (Manatee, Sarasota, Charlotte counties)
- Markets: Bradenton/Parrish, Sarasota/Lakewood Ranch, Venice/North Port, Port Charlotte
- Service types: Pest Control (quarterly), Lawn Care (monthly), Mosquito Barrier (every 3 weeks), Tree & Shrub Care (quarterly), Termite (annual), Rodent Control, WDO Inspections
- WaveGuard loyalty tiers: Bronze (1 service), Silver (2 services), Gold (3 services), Platinum (4+ services)
- Team: Adam (field tech), Virginia (office manager), Jose Alvarado (tech), Jacob Heaton (tech)
- Scheduling zones by city: Parrish, Palmetto, Lakewood Ranch, Bradenton, Sarasota, Venice/North Port

RESPONSE FORMAT:
You are talking to the business owner/operator through a command bar UI. Be concise and action-oriented.

1. For DATA QUERIES: Return results in a structured way. Include customer names, key metrics, and counts. Summarize at the top ("Found 12 customers…"), then list the specifics.

2. For DATA FIXES: Show what you found and what you'd change. Ask for confirmation before making changes. Example: "Found 8 customers with no city. I can fill these in based on their ZIP codes — want me to proceed?"

3. For SCHEDULING ACTIONS: Show the proposed changes clearly (who, what date, what service). Ask for confirmation before creating/moving/cancelling appointments.

4. For ANALYSIS: Give direct, opinionated insights. Don't hedge — the operator wants to know what to do.

RULES:
- Always use tools to query real data — never guess or make up numbers
- For write operations (updates, scheduling, cancels), ALWAYS describe what you'll do and ask for confirmation before executing
- When showing customer lists, include: name, city, tier, relevant dates, and the specific data point the query is about
- If the query is ambiguous, make your best interpretation and note your assumption
- Keep responses under 500 words unless the operator asks for a detailed report
- Format numbers nicely: $1,234.56 not 1234.56
- Use emoji sparingly for visual scanning: ⚠️ for issues, ✅ for healthy, 📅 for scheduling, 💰 for money

SCHEDULING INTELLIGENCE:
- Quarterly pest = every ~90 days
- Monthly lawn = every ~30 days  
- Mosquito = every ~21 days
- Overdue = past their expected frequency with no upcoming appointment
- When scheduling, prefer clustering by zone/city on the same day for route efficiency
- Morning window = 8AM-12PM, Afternoon = 12PM-5PM

The current date is ${new Date().toISOString().split('T')[0]}.`;


// ─── MAIN QUERY ENDPOINT ────────────────────────────────────────

router.post('/query', async (req, res, next) => {
  try {
    const { prompt, conversationHistory = [] } = req.body;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({
        error: 'AI not configured',
        message: 'ANTHROPIC_API_KEY is not set. Intelligence Bar requires Claude API access.',
      });
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Build messages array (support multi-turn conversation)
    const messages = [
      ...conversationHistory.slice(-10), // Keep last 10 messages for context
      { role: 'user', content: prompt },
    ];

    let currentMessages = messages;
    let finalResponse = null;
    const toolCalls = [];
    const toolResults = [];

    // Tool-use loop — Claude may call multiple tools before responding
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: currentMessages,
      });

      const toolUses = response.content.filter(c => c.type === 'tool_use');
      const textBlocks = response.content.filter(c => c.type === 'text');

      if (toolUses.length === 0) {
        // No more tool calls — this is the final response
        finalResponse = textBlocks.map(t => t.text).join('\n');
        break;
      }

      // Execute all tool calls in this round
      const results = [];
      for (const toolUse of toolUses) {
        logger.info(`[intelligence-bar] Tool call: ${toolUse.name}`, toolUse.input);

        const result = await executeTool(toolUse.name, toolUse.input);
        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });

        toolCalls.push({ name: toolUse.name, input: toolUse.input });
        toolResults.push({ name: toolUse.name, result });
      }

      // Add assistant response + tool results to message chain
      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: results },
      ];
    }

    if (!finalResponse) {
      finalResponse = 'I ran into a complex query that needed too many steps. Try breaking it into smaller questions.';
    }

    // Log the query for analytics
    try {
      await db('intelligence_bar_queries').insert({
        prompt,
        response: finalResponse.substring(0, 5000),
        tool_calls: JSON.stringify(toolCalls),
        created_at: new Date(),
      });
    } catch {
      // Table may not exist yet — non-critical
    }

    res.json({
      response: finalResponse,
      toolCalls,
      // Return the structured data from the last tool call for UI rendering
      structuredData: toolResults.length > 0 ? toolResults[toolResults.length - 1].result : null,
      // Return conversation history for multi-turn
      conversationHistory: [
        ...conversationHistory.slice(-8),
        { role: 'user', content: prompt },
        { role: 'assistant', content: finalResponse },
      ],
    });

  } catch (err) {
    logger.error('[intelligence-bar] Query failed:', err);
    next(err);
  }
});


// ─── EXECUTE CONFIRMED ACTION ───────────────────────────────────

router.post('/execute', async (req, res, next) => {
  try {
    const { action, params } = req.body;

    if (!action) {
      return res.status(400).json({ error: 'Action is required' });
    }

    const result = await executeTool(action, params);

    logger.info(`[intelligence-bar] Executed action: ${action}`, params);

    res.json({
      success: !result.error,
      result,
    });

  } catch (err) {
    logger.error('[intelligence-bar] Execute failed:', err);
    next(err);
  }
});


// ─── QUICK ACTIONS (pre-built prompts for common tasks) ─────────

router.get('/quick-actions', async (req, res) => {
  res.json({
    actions: [
      { id: 'missing_city', label: 'Missing Cities', prompt: 'Show me customers with no city on their profile', icon: '📍' },
      { id: 'pest_overdue', label: 'Pest Overdue', prompt: 'Which quarterly pest control customers are overdue for service?', icon: '🐛' },
      { id: 'lawn_overdue', label: 'Lawn Overdue', prompt: 'Which monthly lawn care customers are overdue?', icon: '🌿' },
      { id: 'at_risk', label: 'At Risk', prompt: 'Show me customers with health scores below 40', icon: '⚠️' },
      { id: 'no_email', label: 'Missing Emails', prompt: 'Customers with no email address', icon: '📧' },
      { id: 'high_balance', label: 'Outstanding Balances', prompt: 'Who has an outstanding balance over $100?', icon: '💰' },
      { id: 'duplicates', label: 'Duplicates', prompt: 'Find duplicate customers by phone number', icon: '👥' },
      { id: 'schedule_gaps', label: 'Schedule Gaps', prompt: `What does this week's schedule look like? Any gaps?`, icon: '📅' },
      { id: 'tech_performance', label: 'Tech Performance', prompt: 'Compare technician performance this month', icon: '📊' },
      { id: 'win_back', label: 'Win Back', prompt: 'Show churned customers from the last 6 months who were Gold or Platinum tier', icon: '🔄' },
    ],
  });
});


module.exports = router;
