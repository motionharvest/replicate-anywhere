#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import Replicate from 'replicate';

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_API_TOKEN) {
  throw new Error('REPLICATE_API_TOKEN environment variable is required');
}

const MAX_POLL_TIME = Number.parseInt(process.env.MAX_POLL_TIME || '300000', 10);

interface ModelSearchResult {
  owner: string;
  name: string;
  description: string;
  run_count: number;
  url: string;
  cover_image_url?: string;
}

interface ModelVersion {
  id: string;
  created_at: string;
  openapi_schema?: {
    components?: {
      schemas?: {
        Input?: {
          type: string;
          properties?: Record<string, {
            type?: string;
            description?: string;
            default?: unknown;
            enum?: unknown[];
            minimum?: number;
            maximum?: number;
            format?: string;
          }>;
          required?: string[];
        };
        Output?: unknown;
      };
    };
  };
}

interface ModelInfo {
  owner: string;
  name: string;
  description: string;
  visibility: string;
  github_url?: string;
  paper_url?: string;
  license_url?: string;
  run_count: number;
  cover_image_url?: string;
  default_example?: unknown;
  latest_version?: ModelVersion;
}

class ReplicateServer {
  private server: Server;
  private replicate: Replicate;
  private readonly MAX_POLL_TIME: number;

  constructor() {
    this.MAX_POLL_TIME = MAX_POLL_TIME;

    this.replicate = new Replicate({
      auth: REPLICATE_API_TOKEN!,
    });

    this.server = new Server(
      {
        name: 'replicate-mcp-server',
        version: '2.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error: unknown) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'search-models',
          description: 'IMPORTANT: This tool MUST be called FIRST before asking any clarifying questions about model names. When a user mentions ANY model name (exact, fuzzy, or incomplete like "flux", "stable diffusion", "nano banana pro"), immediately search for it. Do NOT ask the user to confirm model names - search first, then pick the best match from results based on name similarity and run count. Only ask for clarification if the search returns zero results.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query - can be a model name, description, or capability (e.g., "image generation", "flux pro", "stable diffusion xl", "nano banana"). Use the exact text the user provided.',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'get-model-info',
          description: 'Get detailed information about a specific Replicate model including its input parameters schema. Call this AFTER search-models to get parameter details for the best matching model before running it.',
          inputSchema: {
            type: 'object',
            properties: {
              owner: {
                type: 'string',
                description: 'The owner/organization of the model from search results (e.g., "stability-ai", "black-forest-labs")',
              },
              name: {
                type: 'string',
                description: 'The name of the model from search results (e.g., "stable-diffusion", "flux-pro")',
              },
            },
            required: ['owner', 'name'],
          },
        },
        {
          name: 'run-model',
          description: 'Run a prediction on any Replicate model. WORKFLOW: If the user provides a fuzzy model name, first call search-models to find the exact model identifier, then call get-model-info to understand required parameters, then call this tool.',
          inputSchema: {
            type: 'object',
            properties: {
              model: {
                type: 'string',
                description: 'Model identifier in format "owner/name" or "owner/name:version" (e.g., "stability-ai/stable-diffusion", "black-forest-labs/flux-pro"). Must be an exact identifier from search-models results.',
              },
              input: {
                type: 'object',
                description: 'Input parameters for the model. The required parameters depend on the specific model - use get-model-info to see what parameters are needed.',
                additionalProperties: true,
              },
            },
            required: ['model', 'input'],
          },
        },
        {
          name: 'list-models',
          description: 'List public models on Replicate. Use search-models instead when the user mentions a specific model name - this tool is only for browsing all available models without a specific query.',
          inputSchema: {
            type: 'object',
            properties: {
              cursor: {
                type: 'string',
                description: 'Cursor for pagination (from previous response)',
              },
            },
            required: [],
          },
        },
        {
          name: 'check-prediction',
          description: 'Check the status of a running prediction. Use this if a previous run-model call returned a prediction_id with status "processing".',
          inputSchema: {
            type: 'object',
            properties: {
              prediction_id: {
                type: 'string',
                description: 'The prediction ID returned from a previous run-model call',
              },
            },
            required: ['prediction_id'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'search-models':
            return await this.handleSearchModels(args);
          case 'get-model-info':
            return await this.handleGetModelInfo(args);
          case 'run-model':
            return await this.handleRunModel(args);
          case 'list-models':
            return await this.handleListModels(args);
          case 'check-prediction':
            return await this.handleCheckPrediction(args);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (error: unknown) {
        if (error instanceof McpError) {
          throw error;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new McpError(
          ErrorCode.InternalError,
          `Replicate API error: ${errorMessage}`
        );
      }
    });
  }

  private isImageUrl(url: string): boolean {
    if (typeof url !== 'string') return false;
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
    const lowerUrl = url.toLowerCase();
    // Check for image extensions or known image delivery domains
    return imageExtensions.some(ext => lowerUrl.includes(ext)) ||
           lowerUrl.includes('replicate.delivery') ||
           lowerUrl.includes('pbxt.replicate.delivery');
  }

  private formatOutput(output: unknown): string {
    // Handle array of URLs (common for image models)
    if (Array.isArray(output)) {
      const imageUrls = output.filter(item => typeof item === 'string' && this.isImageUrl(item));
      if (imageUrls.length > 0) {
        const markdown = imageUrls.map((url, index) => 
          `![Generated Image ${index + 1}](${url})`
        ).join('\n\n');
        return `**Generated Images:**\n\n${markdown}\n\n**Direct links:**\n${imageUrls.map((url, i) => `- [Image ${i + 1}](${url})`).join('\n')}`;
      }
    }
    
    // Handle single URL string
    if (typeof output === 'string' && this.isImageUrl(output)) {
      return `**Generated Image:**\n\n![Generated Image](${output})\n\n**Direct link:** ${output}`;
    }

    // Handle object with url/image property
    if (output && typeof output === 'object') {
      const obj = output as Record<string, unknown>;
      const imageUrl = obj.url || obj.image || obj.output;
      if (typeof imageUrl === 'string' && this.isImageUrl(imageUrl)) {
        return `**Generated Image:**\n\n![Generated Image](${imageUrl})\n\n**Direct link:** ${imageUrl}`;
      }
    }

    // Default: return JSON
    return JSON.stringify({ status: 'succeeded', output }, null, 2);
  }

  private async handleSearchModels(args?: Record<string, unknown>) {
    if (!args?.query || typeof args.query !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'query is required and must be a string');
    }

    const query = args.query;
    console.error(`Searching for models: "${query}"`);

    const results: ModelSearchResult[] = [];

    try {
      // Try the newer search API first (replicate.search)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const replicateAny = this.replicate as any;
      
      console.error(`Available APIs: replicate.search=${typeof replicateAny.search}, models.search=${typeof replicateAny.models?.search}`);
      
      if (typeof replicateAny.search === 'function') {
        console.error('Using replicate.search() API');
        const response = await replicateAny.search({ query });
        console.error(`Search response keys: ${Object.keys(response || {}).join(', ')}`);
        
        // Handle different response formats
        const modelList = response?.models || response?.results || (Array.isArray(response) ? response : []);
        
        for (const item of modelList.slice(0, 10)) {
          const model = item.model || item;
          results.push({
            owner: model.owner,
            name: model.name,
            description: model.description || item.metadata?.generated_description || '',
            run_count: model.run_count || 0,
            url: model.url,
            cover_image_url: model.cover_image_url,
          });
        }
      } else if (typeof replicateAny.models?.search === 'function') {
        // Try models.search() if available
        console.error('Using replicate.models.search() API');
        const searchResults = await replicateAny.models.search(query);
        
        // Handle different response formats
        const modelList = Array.isArray(searchResults) 
          ? searchResults 
          : (searchResults?.results || searchResults?.models || []);
        
        for (const model of modelList.slice(0, 10)) {
          results.push({
            owner: model.owner,
            name: model.name,
            description: model.description || '',
            run_count: model.run_count || 0,
            url: model.url,
            cover_image_url: model.cover_image_url,
          });
        }
      } else {
        // Fallback: list all models and filter client-side
        console.error('Falling back to client-side filtering of models.list()');
        const queryLower = query.toLowerCase();
        const listResponse = await this.replicate.models.list();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const page = listResponse as any;
        
        for (const model of page.results || []) {
          const matchesName = model.name?.toLowerCase().includes(queryLower);
          const matchesOwner = model.owner?.toLowerCase().includes(queryLower);
          const matchesDescription = model.description?.toLowerCase().includes(queryLower);
          
          if (matchesName || matchesOwner || matchesDescription) {
            results.push({
              owner: model.owner,
              name: model.name,
              description: model.description || '',
              run_count: model.run_count || 0,
              url: model.url,
              cover_image_url: model.cover_image_url,
            });
            if (results.length >= 10) break;
          }
        }
      }

      console.error(`Found ${results.length} models`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              query,
              results_count: results.length,
              models: results.map(m => ({
                identifier: `${m.owner}/${m.name}`,
                description: m.description,
                run_count: m.run_count,
                url: m.url,
              })),
            }, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      console.error('Search error:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to search models: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleGetModelInfo(args?: Record<string, unknown>) {
    if (!args?.owner || typeof args.owner !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'owner is required and must be a string');
    }
    if (!args?.name || typeof args.name !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'name is required and must be a string');
    }

    console.error(`Getting model info: ${args.owner}/${args.name}`);

    try {
      const model = await this.replicate.models.get(args.owner, args.name) as ModelInfo;

      // Extract input schema from openapi_schema
      const inputSchema = model.latest_version?.openapi_schema?.components?.schemas?.Input;

      // Format the input parameters for clarity
      let inputParams: Array<{
        name: string;
        type?: string;
        description?: string;
        default?: unknown;
        required: boolean;
        enum?: unknown[];
        minimum?: number;
        maximum?: number;
      }> = [];

      if (inputSchema?.properties) {
        const requiredFields = inputSchema.required || [];
        inputParams = Object.entries(inputSchema.properties).map(([paramName, paramInfo]) => ({
          name: paramName,
          type: paramInfo.type,
          description: paramInfo.description,
          default: paramInfo.default,
          required: requiredFields.includes(paramName),
          enum: paramInfo.enum,
          minimum: paramInfo.minimum,
          maximum: paramInfo.maximum,
        }));
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              identifier: `${model.owner}/${model.name}`,
              description: model.description,
              visibility: model.visibility,
              run_count: model.run_count,
              github_url: model.github_url,
              paper_url: model.paper_url,
              license_url: model.license_url,
              latest_version: model.latest_version?.id,
              input_parameters: inputParams,
              required_parameters: inputParams.filter(p => p.required).map(p => p.name),
            }, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      console.error('Get model info error:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get model info: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleRunModel(args?: Record<string, unknown>) {
    if (!args?.model || typeof args.model !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'model is required and must be a string (e.g., "owner/name")');
    }
    if (!args?.input || typeof args.input !== 'object') {
      throw new McpError(ErrorCode.InvalidParams, 'input is required and must be an object with model parameters');
    }

    const modelIdentifier = args.model;
    const input = args.input as Record<string, unknown>;

    console.error(`Running model: ${modelIdentifier}`);
    console.error(`Input: ${JSON.stringify(input)}`);

    try {
      // Parse model identifier
      const [ownerName, version] = modelIdentifier.split(':');
      const [owner, name] = ownerName.split('/');

      if (!owner || !name) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'model must be in format "owner/name" or "owner/name:version"'
        );
      }

      // If no version specified, get the latest version
      let versionId = version;
      if (!versionId) {
        const modelInfo = await this.replicate.models.get(owner, name) as ModelInfo;
        if (!modelInfo.latest_version?.id) {
          throw new McpError(
            ErrorCode.InternalError,
            `Model ${modelIdentifier} has no published versions`
          );
        }
        versionId = modelInfo.latest_version.id;
        console.error(`Using latest version: ${owner}/${name}:${versionId}`);
      }

      // Create the prediction (returns immediately)
      console.error(`Creating prediction...`);
      const prediction = await this.replicate.predictions.create({
        version: versionId,
        input: input,
      });

      console.error(`Prediction created: ${prediction.id}`);
      console.error(`Status: ${prediction.status}`);

      // Poll for completion with timeout
      const startTime = Date.now();
      let currentPrediction = prediction;

      while (
        currentPrediction.status !== 'succeeded' &&
        currentPrediction.status !== 'failed' &&
        currentPrediction.status !== 'canceled'
      ) {
        // Check if we've exceeded max poll time
        if (Date.now() - startTime > this.MAX_POLL_TIME) {
          console.error(`Prediction still running after ${this.MAX_POLL_TIME}ms, returning status`);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  model: modelIdentifier,
                  status: 'processing',
                  message: 'Prediction is still running. Check the URL below for results.',
                  prediction_id: currentPrediction.id,
                  prediction_url: `https://replicate.com/p/${currentPrediction.id}`,
                  current_status: currentPrediction.status,
                }, null, 2),
              },
            ],
          };
        }

        // Wait before polling again
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Get updated prediction status
        currentPrediction = await this.replicate.predictions.get(prediction.id);
        console.error(`Poll status: ${currentPrediction.status}`);
      }

      if (currentPrediction.status === 'failed') {
        throw new McpError(
          ErrorCode.InternalError,
          `Prediction failed: ${currentPrediction.error || 'Unknown error'}`
        );
      }

      if (currentPrediction.status === 'canceled') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                model: modelIdentifier,
                status: 'canceled',
                prediction_id: currentPrediction.id,
              }, null, 2),
            },
          ],
        };
      }

      console.error('Prediction completed!');

      // Format output - detect image URLs and format as markdown
      const output = currentPrediction.output;
      const formattedOutput = this.formatOutput(output);

      return {
        content: [
          {
            type: 'text',
            text: formattedOutput,
          },
        ],
      };
    } catch (error: unknown) {
      console.error('Run model error:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to run model: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleListModels(args?: Record<string, unknown>) {
    const cursor = args?.cursor as string | undefined;

    console.error('Listing models...');

    try {
      // Note: The Replicate SDK v1.4.0 doesn't support cursor parameter directly
      // We pass it but it may be ignored depending on SDK version
      const response = await this.replicate.models.list();

      const models: Array<{
        identifier: string;
        description: string;
        run_count: number;
        url: string;
      }> = [];

      // The response is a Page object with results array
      const page = response as { results: Array<{ owner: string; name: string; description?: string; run_count?: number; url: string }>; next?: string };
      
      for (const model of page.results || []) {
        models.push({
          identifier: `${model.owner}/${model.name}`,
          description: model.description || '',
          run_count: model.run_count || 0,
          url: model.url,
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              models,
              next_cursor: page.next,
            }, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      console.error('List models error:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list models: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleCheckPrediction(args?: Record<string, unknown>) {
    if (!args?.prediction_id || typeof args.prediction_id !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'prediction_id is required and must be a string');
    }

    const predictionId = args.prediction_id;
    console.error(`Checking prediction: ${predictionId}`);

    try {
      const prediction = await this.replicate.predictions.get(predictionId);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const predictionAny = prediction as any;

      if (prediction.status === 'succeeded') {
        const formattedOutput = this.formatOutput(prediction.output);
        return {
          content: [
            {
              type: 'text',
              text: formattedOutput,
            },
          ],
        };
      } else if (prediction.status === 'failed') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'failed',
                prediction_id: predictionId,
                error: prediction.error,
                prediction_url: `https://replicate.com/p/${predictionId}`,
              }, null, 2),
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: prediction.status,
                prediction_id: predictionId,
                prediction_url: `https://replicate.com/p/${predictionId}`,
                message: 'Prediction is still running. Try again in a few seconds.',
              }, null, 2),
            },
          ],
        };
      }
    } catch (error: unknown) {
      console.error('Check prediction error:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to check prediction: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Replicate MCP server running on stdio');
    console.error(`Max poll time: ${this.MAX_POLL_TIME}ms`);
  }
}

const server = new ReplicateServer();
server.run().catch(console.error);
