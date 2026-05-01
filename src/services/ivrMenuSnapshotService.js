import Workflow from '../models/Workflow.js';
import WorkflowExecution from '../models/WorkflowExecution.js';
import logger from '../utils/logger.js';

export const formatIVRMenu = (menu, usageByWorkflow = new Map()) => {
  const nodes = Array.isArray(menu?.nodes) ? menu.nodes : [];
  const edges = Array.isArray(menu?.edges) ? menu.edges : [];
  const config = menu?.config || {};
  const greetingNode = nodes.find((node) => node?.type === 'greeting');
  const inputNodes = nodes.filter((node) => node?.type === 'input');
  const usage = usageByWorkflow.get(String(menu?._id)) || {};

  const validInputNodes = inputNodes.filter((node) => {
    const digit = String(node?.data?.digit ?? '').trim();
    if (!digit) {
      logger.warn(`Input node missing digit in menu ${menu?.promptKey || menu?._id}, skipping node`);
      return false;
    }
    return true;
  });

  return {
    _id: menu._id,
    promptKey: menu.promptKey,
    displayName: menu.displayName,
    greeting: {
      text: menu.text || greetingNode?.data?.text || 'Welcome',
      voice: config.voiceId || 'en-GB-SoniaNeural',
      language: config.language || 'en-GB'
    },
    menuOptions: validInputNodes.map((node) => ({
      digit: node.data.digit,
      label: node.data?.label || 'Option',
      action: node.data?.action || 'transfer',
      destination: node.data?.destination || ''
    })),
    settings: {
      timeout: config.timeout || 10,
      maxAttempts: config.maxAttempts || 3,
      invalidInputMessage: config.invalidInputMessage || 'Invalid selection. Please try again.'
    },
    workflowConfig: {
      nodes,
      edges,
      settings: config
    },
    status: menu.status || (menu.isActive ? 'active' : 'inactive'),
    tags: menu.tags || [],
    contactsUsed: usage.contactsUsed || 0,
    totalExecutions: usage.totalExecutions || 0,
    nodeCount: typeof menu.nodeCount === 'number' ? menu.nodeCount : nodes.length,
    edgeCount: typeof menu.edgeCount === 'number' ? menu.edgeCount : edges.length,
    isComplete: typeof menu.isComplete === 'boolean' ? menu.isComplete : (nodes.length > 0 && edges.length > 0),
    createdAt: menu.createdAt,
    updatedAt: menu.updatedAt
  };
};

export const getIVRMenuSnapshot = async (userId) => {
  const menus = await Workflow.find({ isActive: true, createdBy: userId })
    .select('promptKey displayName text nodes edges config status tags createdAt updatedAt')
    .sort({ promptKey: 1 });

  const workflowIds = menus.map((menu) => menu._id);
  const usageByWorkflow = new Map();

  if (workflowIds.length > 0) {
    const usageStats = await WorkflowExecution.aggregate([
      { $match: { workflowId: { $in: workflowIds } } },
      {
        $group: {
          _id: '$workflowId',
          totalExecutions: { $sum: 1 },
          uniqueContacts: { $addToSet: '$callerNumber' }
        }
      },
      {
        $project: {
          totalExecutions: 1,
          contactsUsed: { $size: '$uniqueContacts' }
        }
      }
    ]);

    usageStats.forEach((item) => {
      usageByWorkflow.set(String(item._id), {
        contactsUsed: item.contactsUsed || 0,
        totalExecutions: item.totalExecutions || 0
      });
    });
  }

  return menus.map((menu) => formatIVRMenu(menu, usageByWorkflow));
};

export const buildIVRMenuListPayload = async (userId) => {
  const ivrMenus = await getIVRMenuSnapshot(userId);
  return {
    success: true,
    ivrMenus,
    count: ivrMenus.length,
    timestamp: new Date().toISOString()
  };
};
