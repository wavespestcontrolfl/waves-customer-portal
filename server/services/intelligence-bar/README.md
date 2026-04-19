# Intelligence Bar — Tool Module Template

How to add a new context-specific tool module. One file per context, six lines of wiring in the route, optional UI hookup.

## Step 1: Create the tool module

Create `server/services/intelligence-bar/{context}-tools.js`:

```js
const db = require('../../models/db');
const logger = require('../logger');

const MY_TOOLS = [
  {
    name: 'tool_name',
    description: `What this tool does and when to use it.
Use for: "example query 1", "example query 2"`,
    input_schema: {
      type: 'object',
      properties: {
        param1: { type: 'string', description: 'What this param does' },
      },
    },
  },
  // ... more tools
];

async function executeMyTool(toolName, input) {
  try {
    switch (toolName) {
      case 'tool_name': return await toolImplementation(input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:mycontext] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

async function toolImplementation(input) {
  // Query the database, return JSON
  const rows = await db('some_table').where(/* ... */).select(/* ... */);
  return { results: rows, total: rows.length };
}

module.exports = { MY_TOOLS, executeMyTool };
```

**Test your SQL.** Wrap uncertain tables or columns in try/catch — don't let one bad query crash the whole tool module.

## Step 2: Wire into the route (6 changes in `server/routes/admin-intelligence-bar.js`)

```js
// 1. Import (top of file, with other imports)
const { MY_TOOLS, executeMyTool } = require('../services/intelligence-bar/my-tools');

// 2. Tool names set (after other TOOL_NAMES)
const MY_TOOL_NAMES = new Set(MY_TOOLS.map(t => t.name));

// 3. Context prompt (in CONTEXT_PROMPTS object)
CONTEXT_PROMPTS.mycontext = `
MY CONTEXT:
Description of what this page does and what the operator is trying to accomplish.
...`;

// 4. Tool loading (in getToolsForContext)
if (context === 'mycontext') {
  return [...TOOLS, ...MY_TOOLS];
}

// 5. Tool execution (in executeToolByName)
if (MY_TOOL_NAMES.has(toolName)) {
  return executeMyTool(toolName, input);
}

// 6. Quick actions (in GET /quick-actions handler)
} else if (context === 'mycontext') {
  res.json({ actions: [
    { id: 'action1', label: 'Label', prompt: 'What to ask Claude', icon: '📊' },
    // ...
  ] });
```

## Step 3: Add to GlobalCommandPalette route mapping

In `client/src/components/admin/GlobalCommandPalette.jsx`:

```js
// In ROUTE_CONTEXT_MAP:
'/admin/mypage': 'mycontext',

// In CONTEXT_LABELS:
mycontext: 'My Page Name',

// In CONTEXT_COLORS:
mycontext: D.teal,  // or D.purple, D.green, D.amber, '#3b82f6'
```

## Step 4 (optional): Add embedded bar to the page

⌘K already covers every admin page. Only add an embedded bar if the page is data-rich and frequently used.

```jsx
import SEOIntelligenceBar from '../../components/admin/SEOIntelligenceBar';

// After the header, before the main content:
<SEOIntelligenceBar context="mycontext" />
```

`SEOIntelligenceBar` is the generic reusable wrapper — pass a `context` prop. Only build a custom wrapper if you need to inject page-specific React state as `pageData`.
