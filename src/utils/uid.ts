const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generates a random 128-bit identifier encoded as a Crockford Base32 string.
 *
 * Crockford Base32 alphabet: 0123456789ABCDEFGHJKMNPQRSTVWXYZ
 * - Excludes I, L, O, U to avoid confusion and accidental obscenity
 * - Each symbol encodes 5 bits
 * - 128 bits → 26 characters (zero-extended to 130 bits)
 *
 * @see https://www.crockford.com/base32.html
 */
function generateCrockfordUID(): string {
	// Generate 128 random bits (16 bytes)
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);

	// Encode bytes directly into Crockford Base32 by extracting 5-bit groups
	// from a running bit buffer. 16 bytes = 128 bits → 26 chars (padded to 130 bits).
	let result = "";
	let buffer = 0;
	let bitsInBuffer = 0;

	for (let i = 0; i < bytes.length; i++) {
		buffer = (buffer << 8) | bytes[i];
		bitsInBuffer += 8;

		while (bitsInBuffer >= 5) {
			bitsInBuffer -= 5;
			result += CROCKFORD_ALPHABET[(buffer >> bitsInBuffer) & 0x1f];
		}
	}

	// Flush remaining bits (< 5), left-shift to fill a 5-bit group
	if (bitsInBuffer > 0) {
		result += CROCKFORD_ALPHABET[(buffer << (5 - bitsInBuffer)) & 0x1f];
	}

	return result;
}

/**
 * Generates a UID of the requested length using Crockford Base32 encoding.
 *
 * Iteratively generates Crockford UIDs until enough characters are available,
 * then returns the first `length` characters.
 *
 * @param length Number of characters in the resulting UID (default 10)
 */
export function generateUID(length = 10): string {
	let pool = "";
	while (pool.length < length) {
		pool += generateCrockfordUID();
	}
	return pool.slice(0, length);
}