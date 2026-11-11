/**
 * The EA address allowlist as the user types it: IPv4 literals separated by commas or spaces.
 * Pure code, shared by preference validation, the bridge and the settings page.
 */

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u

export const isIPv4Address = (text: string): boolean => IPV4.test(text)

/**
 * Split an allowlist.
 * @returns the distinct valid addresses in order, and the entries that are not IPv4 literals.
 */
export function parseAddressList(text: string): { addresses: string[]; invalid: string[] } {
  const addresses: string[] = []
  const invalid: string[] = []
  for (const entry of text.split(/[\s,，;；]+/u)) {
    if (entry === '') continue
    if (!isIPv4Address(entry)) invalid.push(entry)
    else if (!addresses.includes(entry)) addresses.push(entry)
  }
  return { addresses, invalid }
}

/** The canonical stored form: valid addresses joined by `, `. */
export const formatAddressList = (addresses: readonly string[]): string => addresses.join(', ')
