const randomToken = () => Math.random().toString(36).slice(2, 10);

const createPendingReplicateId = (modelName = 'model') => {
  const safeName = typeof modelName === 'string' ? modelName : 'model';
  return `pending:${safeName}:${Date.now()}:${randomToken()}`;
};

const isPendingReplicateId = (value) =>
  typeof value === 'string' && value.startsWith('pending:');

module.exports = {
  createPendingReplicateId,
  isPendingReplicateId,
};
