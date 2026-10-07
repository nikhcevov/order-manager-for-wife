import type { FastifyRequest } from 'fastify';
export interface User { id:string; first_name:string; username:string|null; isSeller:boolean }
declare module 'fastify' { interface FastifyRequest { user: User } }
export class ApiError extends Error { constructor(public statusCode:number, public code:string, message:string, public details?:unknown) {super(message);} }
export function seller(req:FastifyRequest):User { if (!req.user?.isSeller) throw new ApiError(403,'forbidden','Seller access required'); return req.user; }
export function owner(req:FastifyRequest, userId:string):void { if (!req.user || (!req.user.isSeller && req.user.id !== userId)) throw new ApiError(404,'not_found','Record not found'); }
export function version(actual:number, expected:number):void { if (actual !== expected) throw new ApiError(409,'stale_version','This record changed. Refresh and review it before trying again.', {version:actual}); }
