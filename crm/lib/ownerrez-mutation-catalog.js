'use strict';

// Snapshot of every POST/PATCH/DELETE operation in OwnerRez's official v2
// OpenAPI contract as observed 2026-08-11. The operation id is the capability
// boundary; callers cannot supply a method or URL.

const integer = Object.freeze({ type: 'integer' });
const fieldEntity = Object.freeze({ type: 'enum', values: ['booking', 'property', 'quote', 'user', 'guest', 'owner'] });
const tagEntity = Object.freeze({ type: 'enum', values: ['booking', 'inquiry', 'property', 'quote', 'guest', 'blocked_off_time', 'owner'] });

function entry(operationId, method, path, options = {}) {
  return Object.freeze({
    operationId,
    method,
    path,
    pathParams: options.pathParams || {},
    queryParams: options.queryParams || {},
    bodyType: options.bodyType || 'none',
    readback: options.readback || null,
    destructive: method === 'DELETE',
  });
}

const idPath = Object.freeze({ id: integer });
const created = resource => ({ mode: 'created_entity', resource });
const same = resource => ({ mode: 'same_entity', resource });
const deleted = resource => ({ mode: 'deleted_entity', resource });

const ENTRIES = [
  entry('Bookings_Post', 'POST', '/v2/bookings', { bodyType: 'object', readback: created('bookings') }),
  entry('Bookings_Patch', 'PATCH', '/v2/bookings/{id}', { pathParams: idPath, bodyType: 'object_or_array', readback: same('bookings') }),
  entry('Discounts_Post', 'POST', '/v2/discounts', { bodyType: 'object', readback: created('discounts') }),
  entry('Discounts_Patch', 'PATCH', '/v2/discounts/{id}', { pathParams: idPath, bodyType: 'object_or_array', readback: same('discounts') }),
  entry('Discounts_Delete', 'DELETE', '/v2/discounts/{id}', { pathParams: idPath, readback: deleted('discounts') }),
  entry('FieldDefinitions_Post', 'POST', '/v2/fielddefinitions', { bodyType: 'object', readback: created('fielddefinitions') }),
  entry('FieldDefinitions_Patch', 'PATCH', '/v2/fielddefinitions/{id}', { pathParams: idPath, bodyType: 'object_or_array', readback: same('fielddefinitions') }),
  entry('FieldDefinitions_Delete', 'DELETE', '/v2/fielddefinitions/{id}', { pathParams: idPath, readback: deleted('fielddefinitions') }),
  entry('Fields_Post', 'POST', '/v2/fields', { bodyType: 'object', readback: created('fields') }),
  entry('Fields_Patch', 'PATCH', '/v2/fields/{id}', { pathParams: idPath, bodyType: 'object_or_array', readback: same('fields') }),
  entry('Fields_Delete', 'DELETE', '/v2/fields/{id}', { pathParams: idPath, readback: deleted('fields') }),
  entry('Fields_ByDefinition', 'DELETE', '/v2/fields/bydefinition', {
    queryParams: { field_definition_id: integer, entity_id: integer, entity_type: fieldEntity },
    readback: { mode: 'field_definition_absent' },
  }),
  entry('Guests_Post', 'POST', '/v2/guests', { bodyType: 'object', readback: created('guests') }),
  entry('Guests_Patch', 'PATCH', '/v2/guests/{id}', { pathParams: idPath, bodyType: 'object_or_array', readback: same('guests') }),
  entry('Guests_Delete', 'DELETE', '/v2/guests/{id}', { pathParams: idPath, readback: deleted('guests') }),
  entry('Guests_DeleteAddress', 'DELETE', '/v2/guests/{id}/addresses/{address_id}', {
    pathParams: { id: integer, address_id: integer }, readback: { mode: 'guest_child_absent', collection: 'addresses', childParam: 'address_id' },
  }),
  entry('Guests_DeleteEmailAddress', 'DELETE', '/v2/guests/{id}/emailaddresses/{email_address_id}', {
    pathParams: { id: integer, email_address_id: integer }, readback: { mode: 'guest_child_absent', collection: 'email_addresses', childParam: 'email_address_id' },
  }),
  entry('Guests_DeletePhone', 'DELETE', '/v2/guests/{id}/phones/{phone_id}', {
    pathParams: { id: integer, phone_id: integer }, readback: { mode: 'guest_child_absent', collection: 'phones', childParam: 'phone_id' },
  }),
  entry('Messages_Post', 'POST', '/v2/messages', { bodyType: 'object', readback: created('messages') }),
  entry('Quotes_Post', 'POST', '/v2/quotes', { bodyType: 'object', readback: created('quotes') }),
  entry('Quotes_Patch', 'PATCH', '/v2/quotes/{id}', { pathParams: idPath, bodyType: 'object_or_array', readback: same('quotes') }),
  entry('Quotes_Delete', 'DELETE', '/v2/quotes/{id}', { pathParams: idPath, readback: deleted('quotes') }),
  entry('SpotRates_Patch', 'PATCH', '/v2/spotrates', { bodyType: 'array', readback: { mode: 'response_collection' } }),
  entry('Surcharges_Post', 'POST', '/v2/surcharges', { bodyType: 'object', readback: created('surcharges') }),
  entry('Surcharges_Patch', 'PATCH', '/v2/surcharges/{id}', { pathParams: idPath, bodyType: 'object_or_array', readback: same('surcharges') }),
  entry('Surcharges_Delete', 'DELETE', '/v2/surcharges/{id}', { pathParams: idPath, readback: deleted('surcharges') }),
  entry('TagDefinitions_Post', 'POST', '/v2/tagdefinitions', { bodyType: 'object', readback: created('tagdefinitions') }),
  entry('TagDefinitions_Patch', 'PATCH', '/v2/tagdefinitions/{id}', { pathParams: idPath, bodyType: 'object_or_array', readback: same('tagdefinitions') }),
  entry('TagDefinitions_Delete', 'DELETE', '/v2/tagdefinitions/{id}', { pathParams: idPath, readback: deleted('tagdefinitions') }),
  entry('Tags_Post', 'POST', '/v2/tags', { bodyType: 'object', readback: created('tags') }),
  entry('Tags_Delete', 'DELETE', '/v2/tags/{id}', { pathParams: idPath, readback: deleted('tags') }),
  entry('Tags_ByName', 'DELETE', '/v2/tags/byname', {
    queryParams: { name: { type: 'string' }, entity_id: integer, entity_type: tagEntity },
    readback: { mode: 'tag_name_absent' },
  }),
  entry('WebhookSubscriptions_Post', 'POST', '/v2/webhooksubscriptions', { bodyType: 'object', readback: created('webhooksubscriptions') }),
  entry('WebhookSubscriptions_Delete', 'DELETE', '/v2/webhooksubscriptions/{id}', { pathParams: idPath, readback: deleted('webhooksubscriptions') }),
];

const CATALOG = new Map(ENTRIES.map(value => [value.operationId, value]));

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validateParams(specs, supplied, label) {
  if (!plainObject(supplied)) throw new Error(`${label} must be an object`);
  const unknown = Object.keys(supplied).filter(key => !Object.hasOwn(specs, key));
  if (unknown.length) throw new Error(`${label} contains unsupported keys: ${unknown.join(', ')}`);
  for (const [name, spec] of Object.entries(specs)) {
    const value = supplied[name];
    if (value === undefined || value === null || value === '') throw new Error(`${label}.${name} is required`);
    if (spec.type === 'integer' && (!Number.isSafeInteger(Number(value)) || Number(value) <= 0)) {
      throw new Error(`${label}.${name} must be a positive integer`);
    }
    if (spec.type === 'string' && typeof value !== 'string') throw new Error(`${label}.${name} must be a string`);
    if (spec.type === 'enum' && !spec.values.includes(String(value))) {
      throw new Error(`${label}.${name} must be one of: ${spec.values.join(', ')}`);
    }
  }
}

function validateMutationInput(input) {
  if (!plainObject(input)) throw new Error('OwnerRez mutation input is required');
  const operation = CATALOG.get(String(input.operationId || ''));
  if (!operation) throw new Error('unsupported OwnerRez v2 mutation operationId');
  const pathParams = input.pathParams || {};
  const query = input.query || {};
  validateParams(operation.pathParams, pathParams, 'pathParams');
  validateParams(operation.queryParams, query, 'query');
  if (operation.bodyType === 'object' && !plainObject(input.body)) throw new Error('body must be an object');
  if (operation.bodyType === 'array' && (!Array.isArray(input.body) || input.body.length === 0)) {
    throw new Error('body must be a non-empty array');
  }
  if (operation.bodyType === 'object_or_array'
      && !plainObject(input.body) && (!Array.isArray(input.body) || input.body.length === 0)) {
    throw new Error('body must be an object or a non-empty array');
  }
  if (operation.bodyType === 'none' && input.body !== undefined && input.body !== null) {
    throw new Error('this OwnerRez operation does not accept a request body');
  }
  const reason = String(input.reason || '').trim();
  if (reason.length < 4 || reason.length > 500) throw new Error('reason must be between 4 and 500 characters');
  return { operation, pathParams, query, body: input.body, reason };
}

function resolvePath(operation, pathParams) {
  let resolved = operation.path;
  for (const [name, value] of Object.entries(pathParams || {})) {
    resolved = resolved.replace(`{${name}}`, encodeURIComponent(String(value)));
  }
  if (resolved.includes('{')) throw new Error('OwnerRez path parameters are incomplete');
  return resolved;
}

module.exports = {
  CATALOG,
  ENTRIES,
  plainObject,
  resolvePath,
  validateMutationInput,
  validateParams,
};
