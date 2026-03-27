import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ─── MCP server configs ────────────────────────────────────────────────────
// Adjust command/args to match however you launch each MCP server locally.
const MCP = {
  hubspot: {
    command: 'npx',
    args: ['-y', '@hubspot/mcp-server'],
    env: { HUBSPOT_ACCESS_TOKEN: process.env.HUBSPOT_ACCESS_TOKEN }
  },
  airtable: {
    command: 'npx',
    args: ['-y', 'airtable-mcp-server'],
    env: { AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY }
  },
  slack: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: {
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
      SLACK_TEAM_ID: process.env.SLACK_TEAM_ID,
      SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID,
      SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET,
      SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET
    }
  }
};

// Spawn an MCP client, run fn(client), then close
async function withMcp(key, fn) {
  const cfg = MCP[key];
  const client = new Client(
    { name: 'enablement-intake', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    env: { ...process.env, ...cfg.env }
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

// Parse text out of MCP content blocks, then try JSON.parse
function parseMcpContent(content) {
  if (!content) return null;
  const raw = Array.isArray(content)
    ? content.map(b => b.text ?? '').join('\n')
    : String(content);
  try { return JSON.parse(raw); } catch { return raw; }
}

// Extract an array from a parsed MCP response regardless of how it's wrapped
function extractArray(parsed, ...keys) {
  if (Array.isArray(parsed)) return parsed;
  for (const key of keys) {
    if (Array.isArray(parsed?.[key])) return parsed[key];
  }
  return [];
}

// ─── Serve index.html ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// ─── Debug: list tools available on each MCP server ───────────────────────
app.get('/api/debug/tools', async (req, res) => {
  const results = {};
  for (const key of ['airtable', 'slack', 'hubspot']) {
    try {
      const tools = await withMcp(key, async (client) => {
        const r = await client.listTools();
        return r.tools.map(t => ({ name: t.name, description: t.description?.slice(0, 80) }));
      });
      results[key] = tools;
    } catch (err) {
      results[key] = { error: err.message };
    }
  }
  res.json(results);
});

// ─── HubSpot: contacts + open deals for this company ──────────────────────
app.post('/api/hubspot', async (req, res) => {
  const { customerName, pocEmail } = req.body;
  try {
    const data = await withMcp('hubspot', async (client) => {
      const [contactsRaw, dealsRaw] = await Promise.all([
        client.callTool({
          name: 'hubspot_search_crm_objects',
          arguments: {
            objectType: 'contacts',
            filterGroups: [{
              filters: [{ propertyName: 'company', operator: 'CONTAINS_TOKEN', value: customerName }]
            }],
            properties: ['firstname', 'lastname', 'email', 'jobtitle', 'lifecyclestage', 'hs_lead_status']
          }
        }),
        client.callTool({
          name: 'hubspot_search_crm_objects',
          arguments: {
            objectType: 'deals',
            filterGroups: [{
              filters: [{ propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: customerName }]
            }],
            properties: ['dealname', 'amount', 'dealstage', 'closedate', 'pipeline']
          }
        })
      ]);

      const contacts = (parseMcpContent(contactsRaw.content)?.results ?? []).map(c => ({
        name: [c.properties?.firstname, c.properties?.lastname].filter(Boolean).join(' ') || '—',
        email: c.properties?.email ?? '',
        title: c.properties?.jobtitle ?? '',
        stage: c.properties?.lifecyclestage ?? c.properties?.hs_lead_status ?? ''
      }));

      const deals = (parseMcpContent(dealsRaw.content)?.results ?? []).map(d => ({
        name: d.properties?.dealname ?? 'Unnamed deal',
        amount: d.properties?.amount ? Number(d.properties.amount) : null,
        stage: d.properties?.dealstage ?? '',
        closeDate: d.properties?.closedate ?? ''
      }));

      return { contacts, deals };
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Airtable: cohort enrollment records for this company ─────────────────
// Set AIRTABLE_BASE_ID and AIRTABLE_TABLE_ID in your env.
// Assumes a table with fields: Name, Company, Email, Cohort, Status, Enrolled Date, Completed Date
app.post('/api/airtable', async (req, res) => {
  const { customerName } = req.body;
  try {
    const data = await withMcp('airtable', async (client) => {
      const raw = await client.callTool({
        name: 'list_records',
        arguments: {
          baseId: process.env.AIRTABLE_BASE_ID,
          tableId: process.env.AIRTABLE_TABLE_ID,
          filterByFormula: `SEARCH(LOWER("${customerName.replace(/"/g, '')}"), LOWER({Company}))`,
          fields: ['Name', 'Company', 'Email', 'Cohort', 'Status', 'Enrolled Date', 'Completed Date']
        }
      });

      const records = extractArray(parseMcpContent(raw.content), 'records').map(r => ({
        name: r.fields?.Name ?? '—',
        email: r.fields?.Email ?? '',
        cohort: r.fields?.Cohort ?? '—',
        status: r.fields?.Status ?? '—',
        enrolledDate: r.fields?.['Enrolled Date'] ?? '',
        completedDate: r.fields?.['Completed Date'] ?? ''
      }));

      return { records };
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Slack: recent messages from the customer channel ─────────────────────
app.post('/api/slack', async (req, res) => {
  const { slackChannel } = req.body;
  if (!slackChannel) return res.status(400).json({ error: 'No channel provided' });

  try {
    const data = await withMcp('slack', async (client) => {
      // Resolve channel name → ID
      const listRaw = await client.callTool({
        name: 'slack_list_channels',
        arguments: { limit: 500 }
      });
      const channels = extractArray(parseMcpContent(listRaw.content), 'channels');
      const channelName = slackChannel.replace(/^#/, '').toLowerCase();
      const channel = channels.find(c => c.name?.toLowerCase() === channelName);

      if (!channel) {
        return { error: `Channel "${slackChannel}" not found — confirm the bot is a member` };
      }

      const historyRaw = await client.callTool({
        name: 'slack_get_channel_history',
        arguments: { channel_id: channel.id, limit: 40 }
      });

      const messages = extractArray(parseMcpContent(historyRaw.content), 'messages')
        .filter(m => m.text && !m.bot_id)
        .slice(0, 20)
        .map(m => ({
          text: m.text,
          ts: m.ts ? new Date(Number(m.ts) * 1000).toLocaleDateString() : ''
        }));

      return { channel: channel.name, messages };
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Submit: save intake + cross-ref graduates + notify Slack ─────────────
app.post('/api/submit', async (req, res) => {
  const f = req.body; // full form data
  const result = { saved: false, graduated: [], slackSent: false, errors: [] };

  const OUTCOME_LABELS = {
    team_adoption: 'More team members using AI',
    visibility: 'Increased internal visibility',
    sa_independence: 'Reduced reliance on SA',
    other: 'Other'
  };
  const SKILL_LABELS = {
    never: 'Never used it', grid: 'Grid runners', building: 'Active builders',
    advanced: 'Advanced / want a challenge', mixed: 'Mixed team'
  };
  const MOTIVATION_LABELS = {
    where_start: 'Where do I start?', team_spread: 'Spread the skill',
    build_more: 'Just want to build more', customize: 'Customization',
    debug: 'Debugging', challenge: 'Expert seeking a challenge'
  };

  // 1. Write intake record via Airtable automation webhook
  try {
    const ROLE_LABELS    = { ae: 'AE', csm: 'CSM', sa: 'SA', customer: 'Customer directly', other: 'Other' };
    const URGENCY_LABELS = { asap: 'High', '30days': 'Medium', flexible: 'Low' };
    const DEAL_LABELS    = { yes: 'Yes', no: 'No', unknown: 'Unknown' };

    const payload = {
      customerName:  f.customerName,
      requestorName: f.requestorName,
      requestorEmail: f.requestorEmail,
      pocEmail:      f.pocEmail,
      requestorRole: ROLE_LABELS[f.requestorRole] ?? f.requestorRole,
      skillLevel:    SKILL_LABELS[f.skillLevel] ?? f.skillLevel,
      motivations:   (f.motivations ?? []).map(m => MOTIVATION_LABELS[m] ?? m).join(', '),
      outcomes:      (f.outcomes ?? []).map(o => OUTCOME_LABELS[o] ?? o).join(', '),
      urgency:       URGENCY_LABELS[f.timeline] ?? f.timeline,
      dealStatus:    DEAL_LABELS[f.dealStatus] ?? f.dealStatus,
      dealSize:      f.dealSize,
      teamSize:      f.teamSize,
      dealLink:      f.dealLink,
      slackChannel:  f.slackChannel,
      additionalContext: f.additionalContext
    };

    const whRes = await fetch(
      'https://hooks.airtable.com/workflows/v1/genericWebhook/app7FaQVGXksY7aes/wfloedlwByS7oTwqa/wtrFeY6ylvTtpWuJO',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );
    const whJson = await whRes.json().catch(() => ({}));
    if (!whRes.ok) throw new Error(whJson.error ?? `HTTP ${whRes.status}`);
    result.saved = true;
  } catch (err) {
    result.errors.push(`Airtable write: ${err.message}`);
    console.error('[Airtable write]', err);
  }

  // 2. Cross-reference "Graduated Content Engineers" by company
  try {
    await withMcp('airtable', async (client) => {
      const raw = await client.callTool({
        name: 'list_records',
        arguments: {
          baseId: process.env.AIRTABLE_BASE_ID,
          tableId: process.env.AIRTABLE_GRADUATED_TABLE_ID,
          // filterByFormula syntax varies by MCP server version — also try 'formula' if this 404s
          filterByFormula: `SEARCH(LOWER("${f.customerName.replace(/"/g, '')}"), LOWER({Associated Company (Primary)}))`,
          fields: ['Name', 'Associated Company (Primary)', 'Cohort', 'Graduation Date']
        }
      });
      result.graduated = extractArray(parseMcpContent(raw.content), 'records').map(r => ({
        name: r.fields?.Name ?? '—',
        company: r.fields?.['Associated Company (Primary)'] ?? '',
        cohort: r.fields?.Cohort ?? '',
        graduationDate: r.fields?.['Graduation Date'] ?? ''
      }));
    });
  } catch (err) {
    result.errors.push(`Graduated lookup: ${err.message}`);
    console.error('[Graduated lookup]', err);
  }

  // 3. Post to #private-enablement-intake — direct Slack API, no MCP
  try {
    const gradLines = result.graduated.length > 0
      ? result.graduated.map(g => `• ${g.name}${g.cohort ? ` (${g.cohort})` : ''}${g.graduationDate ? ` — graduated ${g.graduationDate}` : ''}`).join('\n')
      : '_None on record_';

    const outcomeStr = (f.outcomes ?? []).map(o => OUTCOME_LABELS[o] ?? o).join(', ') || '—';

    const text = [
      `🟢 *New Private Enablement Request*`,
      ``,
      `*Customer:* ${f.customerName}${f.dealSize ? `  ·  ACV $${Number(f.dealSize).toLocaleString()}` : ''}`,
      `*POC:* ${f.pocEmail}`,
      `*Requestor:* ${f.requestorName || f.requestorEmail}${f.requestorRole ? ` (${f.requestorRole.toUpperCase()})` : ''}`,
      ``,
      `*Skill level:* ${SKILL_LABELS[f.skillLevel] ?? f.skillLevel ?? '—'}`,
      `*Motivation:* ${(f.motivations ?? []).map(m => MOTIVATION_LABELS[m] ?? m).join(', ') || '—'}`,
      `*Desired outcomes:* ${outcomeStr}`,
      `*Team size:* ${f.teamSize || '—'}  ·  *Timeline:* ${f.timeline || '—'}  ·  *Active deal:* ${f.dealStatus || '—'}`,
      f.dealLink ? `*Deal link:* ${f.dealLink}` : null,
      f.slackChannel ? `*Slack channel:* ${f.slackChannel}` : null,
      f.additionalContext ? `\n*Context:* ${f.additionalContext}` : null,
      ``,
      `*Graduated Content Engineers from ${f.customerName}:*`,
      gradLines,
    ].filter(line => line !== null).join('\n');

    const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ channel: 'C0AP8RPKWKE', text })
    });
    const slackJson = await slackRes.json();
    if (!slackJson.ok) throw new Error(slackJson.error);
    result.slackSent = true;
  } catch (err) {
    result.errors.push(`Slack notify: ${err.message}`);
    console.error('[Slack notify]', err);
  }

  res.json(result);
});

export default app;

app.listen(3001, () => {
  console.log('Intake server → http://localhost:3001');
  console.log('[Airtable] key loaded:', process.env.AIRTABLE_API_KEY ? `${process.env.AIRTABLE_API_KEY.slice(0, 12)}...` : 'MISSING');
  console.log('[Airtable] base:', process.env.AIRTABLE_BASE_ID ?? 'MISSING');
  console.log('[Airtable] private enablement table:', process.env.AIRTABLE_PRIVATE_ENABLEMENT_TABLE_ID ?? 'MISSING');
});
