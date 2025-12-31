# Replicate Anywhere

An MCP (Model Context Protocol) server that enables AI assistants to search, discover, and run **any model** on [Replicate](https://replicate.com). No hardcoded model lists - just describe what you want and let the AI find and run the right model.

## Features

- 🔍 **Smart Model Search** - Find models by fuzzy name matching (e.g., "flux", "stable diffusion", "nano banana pro")
- 🤖 **Automatic Model Discovery** - AI searches first, asks questions later
- 📋 **Parameter Detection** - Automatically retrieves and understands model input schemas
- 🖼️ **Inline Image Display** - Image outputs are formatted as markdown for inline display
- ⏱️ **Async Prediction Handling** - Long-running predictions return status URLs instead of timing out
- ✅ **Prediction Status Checking** - Check on running predictions that haven't completed yet

## Installation

### Prerequisites

- Node.js 18+
- A [Replicate API token](https://replicate.com/account/api-tokens)

### NPM (Global)

```bash
npm install -g replicate-anywhere
```

### From Source

```bash
git clone https://github.com/fifthseason-ai/replicate-anywhere.git
cd replicate-anywhere
npm install
npm run build
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REPLICATE_API_TOKEN` | Yes | - | Your Replicate API token |
| `MAX_POLL_TIME` | No | `300000` | Maximum time (ms) to wait for predictions before returning async status |

### MCP Client Configuration

#### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "replicate-anywhere": {
      "command": "npx",
      "args": ["-y", "replicate-anywhere"],
      "env": {
        "REPLICATE_API_TOKEN": "r8_your_token_here"
      }
    }
  }
}
```

#### LibreChat

Add to your `librechat.yaml`:

```yaml
mcpServers:
  replicate-anywhere:
    type: stdio
    command: npx
    args:
      - -y
      - replicate-anywhere
    env:
      REPLICATE_API_TOKEN: "${REPLICATE_API_TOKEN}"
```

#### Docker

```yaml
services:
  replicate-anywhere:
    build:
      context: ./replicate-anywhere
    environment:
      REPLICATE_API_TOKEN: ${REPLICATE_API_TOKEN}
```

## Tools

### `search-models`

Search for AI models on Replicate by name or description. **This tool is designed to be called first** when a user mentions any model name.

```json
{
  "query": "flux pro"
}
```

### `get-model-info`

Get detailed information about a specific model, including its input parameters schema.

```json
{
  "owner": "black-forest-labs",
  "name": "flux-pro"
}
```

### `run-model`

Run a prediction on any Replicate model.

```json
{
  "model": "black-forest-labs/flux-pro",
  "input": {
    "prompt": "A beautiful sunset over mountains",
    "aspect_ratio": "16:9"
  }
}
```

### `list-models`

List public models on Replicate (paginated).

```json
{
  "cursor": "optional_pagination_cursor"
}
```

### `check-prediction`

Check the status of a running prediction.

```json
{
  "prediction_id": "abc123xyz"
}
```

## Usage Examples

### Generate an Image

> **User:** "Generate an image of a cat wearing a space helmet using flux"

The AI will:
1. Call `search-models` with query "flux"
2. Call `get-model-info` to get parameters for the best match
3. Call `run-model` with appropriate parameters
4. Return the image inline (markdown formatted)

### Use a Specific Model

> **User:** "Use stable diffusion xl to create a cyberpunk cityscape"

The AI will search for "stable diffusion xl", find `stability-ai/sdxl`, and run it.

### Check a Long-Running Prediction

> **User:** "Check on my prediction abc123"

The AI will call `check-prediction` to get the current status and output if complete.

## Output Formatting

### Images

When a model returns image URLs, the output is automatically formatted as markdown:

```markdown
**Generated Image:**

![Generated Image](https://replicate.delivery/...)

**Direct link:** https://replicate.delivery/...
```

### Other Outputs

Non-image outputs are returned as JSON.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev

# Run locally
REPLICATE_API_TOKEN=your_token npm start
```

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   AI Assistant  │────▶│ replicate-anywhere│────▶│  Replicate API  │
│  (Claude, etc.) │◀────│    MCP Server    │◀────│                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

The server acts as a bridge between MCP-compatible AI assistants and the Replicate API, providing:
- Tool definitions that guide the AI on how to search and run models
- Smart response formatting for different output types
- Timeout handling for long-running predictions

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## Credits

Built by [Fifth Season AI](https://fifthseason.ai)
