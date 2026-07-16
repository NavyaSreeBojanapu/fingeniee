/**
 * claude.js
 * ---------
 * Thin wrapper around the Anthropic SDK so routes don't repeat the same
 * boilerplate. If ANTHROPIC_API_KEY isn't set, `isConfigured` is false and
 * routes should fall back to their old canned/mock behavior instead of
 * crashing — this keeps the app runnable for teammates who haven't set up
 * a key yet.
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const isConfigured = Boolean(process.env.ANTHROPIC_API_KEY);
const client = isConfigured ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const MODEL = 'claude-sonnet-5';

/**
 * Send a system + user prompt, get back plain text.
 */
async function chatReply(systemPrompt, userMessage, maxTokens = 400) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * Send a system + user prompt, expecting a JSON object back. The system
 * prompt should explicitly instruct Claude to return ONLY JSON, no prose,
 * no markdown fences. Strips fences defensively anyway.
 */
async function chatJSON(systemPrompt, userMessage, maxTokens = 700) {
  const raw = await chatReply(systemPrompt, userMessage, maxTokens);
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  return JSON.parse(cleaned);
}

module.exports = { isConfigured, chatReply, chatJSON, MODEL };