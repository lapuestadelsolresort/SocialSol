'use strict';

const { definition: whatsappReply } = require('./whatsapp-reply');
const { definition: socialContentPublish } = require('./social-publish');
const { definition: ownerrezWebhookProcess } = require('./ownerrez-event');
const { definition: whatsappInboundProcess } = require('./whatsapp-inbound');
const { definition: metaDmReply } = require('./meta-dm-reply');
const { definition: socialPublishDue } = require('./social-publish-due');
const operational = require('./operational-jobs');
const localRecords = require('./local-records');
const readModels = require('./read-models');
const { proposeDefinition: ownerrezMutationPropose, confirmDefinition: ownerrezMutationConfirm } = require('./ownerrez-mutation');

const DEFINITIONS = new Map([
  [whatsappReply.name, whatsappReply],
  [socialContentPublish.name, socialContentPublish],
  [ownerrezWebhookProcess.name, ownerrezWebhookProcess],
  [whatsappInboundProcess.name, whatsappInboundProcess],
  [metaDmReply.name, metaDmReply],
  [socialPublishDue.name, socialPublishDue],
  [ownerrezMutationPropose.name, ownerrezMutationPropose],
  [ownerrezMutationConfirm.name, ownerrezMutationConfirm],
  ...Object.values(operational)
    .filter(value => value && typeof value === 'object' && value.name && Array.isArray(value.steps))
    .map(definition => [definition.name, definition]),
  ...Object.values(localRecords)
    .filter(value => value && typeof value === 'object' && value.name && Array.isArray(value.steps))
    .map(definition => [definition.name, definition]),
  ...Object.values(readModels)
    .filter(value => value && typeof value === 'object' && value.name && Array.isArray(value.steps))
    .map(definition => [definition.name, definition]),
]);

function getDefinition(name) {
  return DEFINITIONS.get(name) || null;
}

function listDefinitions() {
  return [...DEFINITIONS.values()].map(definition => ({
    name: definition.name,
    version: definition.version,
    capability: definition.capability,
    mutates: definition.mutates !== false,
    autonomous: definition.autonomous === true,
    allowed_triggers: definition.allowedTriggers || null,
    steps: definition.steps.map(step => ({ key: step.key, effect_class: step.effectClass || null })),
  }));
}

module.exports = { DEFINITIONS, getDefinition, listDefinitions };
