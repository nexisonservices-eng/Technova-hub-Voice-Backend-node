import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Workflow from '../models/Workflow.js';
import pythonTTSService from '../services/pythonTTSService.js';

// Load environment variables
dotenv.config();

/**
 * Migration script to add audioUrl and audioAssetId fields to existing nodes
 * and copy audio data from legacy greeting object to node level
 */
async function migrateNodeAudioFields() {
    try {
        console.log('Starting migration of node audio fields...');
        
        // Connect to MongoDB
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to MongoDB');

        // Find all IVR workflows that have nodes
        const workflows = await Workflow.find({ 
            'nodes': { $exists: true, $ne: [] }
        });

        console.log(`Found ${workflows.length} workflows to migrate`);

        for (const workflow of workflows) {
            let updated = false;
            
            // Process each node
            for (const node of workflow.nodes) {
                // Check if node already has audio fields
                if (!node.audioUrl && !node.audioAssetId) {
                    // Try to get audio from node.data first
                    if (node.data && node.data.audioUrl) {
                        node.audioUrl = node.data.audioUrl;
                        node.audioAssetId = node.data.audioAssetId || extractAssetId(node.data.audioUrl);
                        updated = true;
                        console.log(`Updated node ${node.id} from data.audioUrl`);
                    }
                    // For greeting nodes, try to get from legacy greeting object
                    else if (node.type === 'greeting' && workflow.greeting && workflow.greeting.audioUrl) {
                        node.audioUrl = workflow.greeting.audioUrl;
                        node.audioAssetId = workflow.greeting.audioAssetId || extractAssetId(workflow.greeting.audioUrl);
                        updated = true;
                        console.log(`Updated greeting node ${node.id} from legacy greeting object`);
                    }
                    // For other nodes with text, generate audio
                    else if (node.data && node.data.text && ['greeting', 'input', 'end', 'voicemail', 'transfer'].includes(node.type)) {
                        try {
                            const promptKey = `workflow_${workflow._id}_node_${node.id}`;
                            const language = node.data.language || workflow.workflowConfig.settings?.language || 'en-GB';
                            
                            console.log(`Generating audio for node ${node.id} with text: ${node.data.text.substring(0, 50)}...`);
                            const audioResult = await pythonTTSService.getAudioForPrompt(promptKey, node.data.text, language);
                            
                            if (audioResult) {
                                node.audioUrl = audioResult.audioUrl;
                                node.audioAssetId = audioResult.publicId;
                                updated = true;
                                console.log(`Generated audio for node ${node.id}: ${audioResult.audioUrl}`);
                            }
                        } catch (error) {
                            console.error(`Failed to generate audio for node ${node.id}:`, error.message);
                            // Set null values to indicate fields exist
                            node.audioUrl = null;
                            node.audioAssetId = null;
                            updated = true;
                        }
                    }
                }
            }

            // Save workflow if updated
            if (updated) {
                await workflow.save();
                console.log(`Saved workflow ${workflow._id} with updated nodes`);
            }
        }

        console.log('Migration completed successfully');
    } catch (error) {
        console.error('Migration failed:', error);
        throw error;
    } finally {
        await mongoose.disconnect();
    }
}

/**
 * Extract asset ID from Cloudinary URL
 */
function extractAssetId(audioUrl) {
    if (!audioUrl || !audioUrl.includes('cloudinary')) {
        return null;
    }
    
    // Extract from URL like: https://res.cloudinary.com/cloud_name/video/upload/v1234567890/folder/public_id.mp3
    const matches = audioUrl.match(/\/video\/upload\/v\d+\/(.+)\.mp3$/);
    return matches ? matches[1] : null;
}

// Run migration if called directly
migrateNodeAudioFields()
    .then(() => {
        console.log('Migration completed');
        process.exit(0);
    })
    .catch((error) => {
        console.error('Migration failed:', error);
        process.exit(1);
    });
