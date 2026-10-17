import { Registry } from '../core/registry';
import coreDomain from './core';
import container from './container';
import network from './network';
import storage from './storage';
import observability from './observability';
import mysql from './mysql';
import redis from './redis';
import offline from './offline';
import compute from './compute';
import sql from './sql';
import data from './data';
import planned, { PLANNED_DOMAINS } from './planned';

export const BUILTIN_DOMAINS = [coreDomain, container, network, storage, observability, mysql, redis, offline, compute, sql, data, planned];

export function builtinRegistry(): Registry {
  const r = new Registry();
  for (const d of BUILTIN_DOMAINS) r.addDomain(d);
  for (const d of PLANNED_DOMAINS) r.addDomain(d);
  return r;
}
