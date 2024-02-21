import * as Rivet from '@ironclad/rivet-node';
import fs from 'fs/promises';
import path from 'path';
import { setupPlugins, logAvailablePluginsInfo } from './pluginConfiguration.js';
import { delay } from './utils.js';
import event from 'events';

logAvailablePluginsInfo();
event.setMaxListeners(100);

class DebuggerServer {
    private static instance: DebuggerServer | null = null;
    private debuggerServer: any = null;

    private constructor() {}

    public static getInstance(): DebuggerServer {
        if (!DebuggerServer.instance) {
            DebuggerServer.instance = new DebuggerServer();
        }
        return DebuggerServer.instance;
    }

    public startDebuggerServerIfNeeded() {
        if (!this.debuggerServer) {
            this.debuggerServer = Rivet.startDebuggerServer();
            console.log('Debugger server started');
        }
        return this.debuggerServer;
    }

    public getDebuggerServer() {
        return this.debuggerServer;
    }
}

export class GraphManager {
    config: any;
    modelContent?: string;

    constructor(params: { config?: any; modelContent?: string }) {
        this.config = params.config || {};
        this.modelContent = params.modelContent;
    }

    async *runGraph(messages: Array<{ type: 'user' | 'assistant'; message: string }>) {
        console.time('runGraph');
        let projectContent: string;
    
        // Ensure the DebuggerServer is started
        DebuggerServer.getInstance().startDebuggerServerIfNeeded();
    
        try {
            // Dynamically setup plugins and retrieve their settings
            const pluginSettings = await setupPlugins(Rivet);

            if (this.modelContent) {
                // Use direct model content if provided
                projectContent = this.modelContent;
            } else {
                // Otherwise, read the model file from the filesystem
                const modelFilePath = path.resolve(process.cwd(), './rivet', this.config.file);
                console.log("-----------------------------------------------------");
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

            const options: Rivet.NodeRunGraphOptions = {
                graph: this.config.graphName,
                inputs: {
                    [graphInput]: {
                        type: 'chat-message[]',
                        value: messages.map(
                            (message) => ({
                                type: message.type,
                                message: message.message,
                            } as Rivet.ChatMessage)
                        ),
                    },
                },
                openAiKey: process.env.OPENAI_API_KEY,
                remoteDebugger: DebuggerServer.getInstance().getDebuggerServer(),
                datasetProvider: datasetProvider,
                pluginSettings,
                context: {
                    ...Object.entries(process.env).reduce((acc, [key, value]) => {
                        acc[key] = value;
                        return acc;
                    }, {}),
                },
                onUserEvent: {
                    // Add "event" node and with id "debugger" to log data from Rivet to the server logs
                    debugger: (data: Rivet.DataValue): Promise<void> => {
                        console.log(`Debugging data: ${JSON.stringify(data)}`);
                        return Promise.resolve();
                    }
                }
            };
            console.log("-----------------------------------------------------");
            console.log('Creating processor');
            const { processor, run } = Rivet.createProcessor(project, options);
            const runPromise = run();
            console.log('Starting to process events');
    
            let lastContent = '';

            for await (const event of processor.events()) {
                // Handle 'partialOutput' events
                if (event.type === 'partialOutput' && event.node?.title?.toLowerCase() === "output") {
                    const content = (event.outputs as any).response?.value || (event.outputs as any).output?.value;
                    if (content && content.startsWith(lastContent)) {
                        const delta = content.slice(lastContent.length);
                        yield delta;
                        lastContent = content;
                    }
                }
                // Handle 'nodeFinish' events with artificial streaming
                else if (
                    event.type === 'nodeFinish' &&
                    event.node?.title?.toLowerCase() === "output" &&
                    !event.node?.type?.includes('chat')
                ) {
                    try {
                        let content = (event.outputs as any).output.value;
                        if (content) {
                            if (typeof content !== 'string') {
                                content = JSON.stringify(content);
                            }
                            // Stream the content character-by-character
                            for (const char of content) {
                                await delay(0.5); // Artifical delay to simulate streaming
                                yield char;
                            }
                        }
                    } catch (error) {
                        console.error(`Error: Cannot return output from node of type ${event.node?.type}. This only works with certain nodes (e.g., text or object)`);
                    }
                }
            }
            
    
            console.log('Finished processing events');
    
            const finalOutputs = await runPromise;
            if (finalOutputs && finalOutputs["output"]) {
                yield finalOutputs["output"].value;
            }
            if (finalOutputs["cost"]) {
                console.log(`Cost: ${finalOutputs["cost"].value}`);
            }
        } catch (error) {
            console.error('Error in runGraph:', error);
        } finally {
            console.timeEnd('runGraph');
            console.log("-----------------------------------------------------");
        }
    }
}
