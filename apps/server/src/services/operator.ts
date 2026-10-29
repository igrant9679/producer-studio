// Who is an operator (P-10): an account whose email is in OPERATOR_EMAILS (cloud only; nobody when it's unset). With
// mail on, the address must also be confirmed, so nobody can become an operator by signing up first with an operator's
// address; with mail off, set OPERATOR_EMAILS only for accounts that already exist.
import type { Context } from 'hono'
import { type AppEnv, type UserRow, requireUser } from '../auth'
import { ctx } from '../context'
import { notFound } from '../http'
import { mailEnabled } from '../mail'

export function isOperator(u: Pick<UserRow, 'email' | 'emailVerifiedAt' | 'disabledAt'> | null | undefined): boolean {
  const list = ctx().config.operatorEmails
  if (!u || !list.length || ctx().config.mode !== 'cloud' || u.disabledAt) return false
  if (!list.includes(u.email.toLowerCase())) return false
  return !mailEnabled() || u.emailVerifiedAt != null
}

/** The signed-in operator, or 404 (to everyone else the operator routes don't exist). */
export function requireOperator(c: Context<AppEnv>): UserRow {
  const u = requireUser(c)
  if (!isOperator(u)) throw notFound()
  return u
}
