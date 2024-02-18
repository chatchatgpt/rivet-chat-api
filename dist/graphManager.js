import * as Rivet from '@ironclad/rivet-node';
import fs from 'fs/promises';
import path from 'path';
// Import and  register plugins
import RivetPluginChroma from "rivet-plugin-chromadb";
Rivet.globalRivetNodeRegistry.registerPlugin(RivetPluginChroma(Rivet));
class DebuggerServer {
    constructor() {
        this.debuggerServer = null;
    }
    static getInstance() {
        if (!DebuggerServer.instance) {
            DebuggerServer.instance = new DebuggerServer();
        }
        return DebuggerServer.instance;
    }
    startDebuggerServerIfNeeded() {
        if (!this.debuggerServer) {
            const serverOptions = {};
            if (process.env.NODE_ENV === 'production') {
                serverOptions.host = '::';
            }
            this.debuggerServer = Rivet.startDebuggerServer(serverOptions);
            console.log('Debugger server started');
        }
        return this.debuggerServer;
    }
    getDebuggerServer() {
        return this.debuggerServer;
    }
}
DebuggerServer.instance = null;
export class GraphManager {
    constructor(params) {
        this.config = params.config || {};
        this.modelContent = params.modelContent;
    }
    async *runGraph(messages) {
        let projectContent;
        // Ensure the DebuggerServer is started
        DebuggerServer.getInstance().startDebuggerServerIfNeeded();
        try {
            if (this.modelContent) {
                // Use direct model content if provided
                projectContent = this.modelContent;
            }
            else {
                // Otherwise, read the model file from the filesystem
                const modelFilePath = path.resolve(process.cwd(), './rivet', this.config.file);
                console.log('runGraph called with model file:', modelFilePath);
                projectContent = await fs.readFile(modelFilePath, 'utf8');
            }
            const project = Rivet.loadProjectFromString(projectContent);
            const graphInput = "input";
            const datasetOptions = {
                save: true,
                // filePath should only be set if you're working with a file, adjust accordingly
                filePath: this.modelContent ? undefined : path.resolve(process.cwd(), './rivet', this.config.file),
            };
            const datasetProvider = this.modelContent ? undefined : await Rivet.NodeDatasetProvider.fromProjectFile(datasetOptions.filePath, datasetOptions);
            const options = {
                graph: this.config.graphName,
                inputs: {
                    [graphInput]: {
                        type: 'chat-message[]',
                        value: messages.map((message) => ({
                            type: message.type,
                            message: message.message,
                        })),
                    },
                },
                openAiKey: process.env.OPENAI_API_KEY,
                remoteDebugger: DebuggerServer.getInstance().getDebuggerServer(),
                datasetProvider: datasetProvider,
                pluginSettings: {
                    chroma: {
                        databaseUri: process.env.CHROMA_DATABASE_URI,
                    },
                },
                context: {
                    ...Object.entries(process.env).reduce((acc, [key, value]) => {
                        acc[key] = value;
                        return acc;
                    }, {}),
                },
                onUserEvent: {
                    debugger: (data) => {
                        console.log(`Debugging data: ${JSON.stringify(data)}`);
                        return Promise.resolve();
                    }
                }
            };
            console.log('Creating processor');
            const { processor, run } = Rivet.createProcessor(project, options);
            const runPromise = run();
            console.log('Starting to process events');
            let lastContent = '';
            for await (const event of processor.events()) {
                if (event.type === 'partialOutput' &&
                    event.node.title.toLowerCase() === "output") {
                    const content = event.outputs.response.value;
                    if (content.startsWith(lastContent)) {
                        const delta = content.slice(lastContent.length);
                        yield delta;
                        lastContent = content;
                    }
                }
            }
            console.log('Finished processing events');
            const finalOutputs = await runPromise;
            if (finalOutputs && finalOutputs["output"]) {
                yield finalOutputs["output"].value;
            }
            console.log('runGraph finished');
        }
        catch (error) {
            console.error('Error in runGraph:', error);
        }
    }
}
//# sourceMappingURL=graphManager.js.map