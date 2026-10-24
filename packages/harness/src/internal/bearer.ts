/** Bearer tokens, which a bridge and a relay check the same way. */

/**
 * Whether `presented` is `expected`, compared in a time that does not depend on where they
 * differ, so that a caller cannot guess the token a character at a time.
 */
export const isPresented = (presented: string | undefined, expected: string) => {
  if (presented === undefined || presented.length !== expected.length) return false
  let difference = 0
  for (let i = 0; i < expected.length; i++) {
    difference |= presented.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return difference === 0
}
