const resolveRequestedCount = (req, featureKey) => {
  if (featureKey === 'voiceCampaign') {
    return Array.isArray(req.body?.contacts) && req.body.contacts.length > 0 ? req.body.contacts.length : 1;
  }
  if (featureKey === 'outboundVoice') {
    return 1;
  }
  return 1;
};

export const requirePlanFeature = (featureKey) => (req, res, next) => {
  const flags = req.user?.featureFlags || {};
  if (!flags[featureKey]) {
    return res.status(403).json({ message: 'Feature not enabled for plan' });
  }

  if (req.user?.canPerformActions === false) {
    return res.status(403).json({ message: 'Workspace is in read-only mode. Actions are blocked until activation.' });
  }

  if (String(req.user?.planCode || '').toLowerCase() === 'trial') {
    const usage = req.user?.trialUsage || {};
    const limits = req.user?.trialLimits || {};
    const requestedCount = resolveRequestedCount(req, featureKey);
    const usedCalls = Number(usage.voiceCalls || 0);
    const callLimit = Number(limits.voiceCalls || 20);
    if ((featureKey === 'voiceCampaign' || featureKey === 'outboundVoice') && usedCalls + requestedCount > callLimit) {
      return res.status(403).json({ message: 'Trial call limit reached. Upgrade to continue.' });
    }
  }

  return next();
};
