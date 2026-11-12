//+------------------------------------------------------------------+
//| DshBridge cryptography: SHA-256 from the terminal (CryptEncode),  |
//| HMAC-SHA256 (RFC 2104) on top of it, hex, a comparison that takes |
//| the same time wherever the inputs differ, and nonces.             |
//+------------------------------------------------------------------+

#define DSH_SHA256_BLOCK 64
#define DSH_SHA256_SIZE  32

//--- The UTF-8 bytes of a string, without the terminating zero.
void DshUtf8(const string text, uchar &bytes[])
  {
   ArrayResize(bytes, 0);
   if(text == "")
      return;
   int length = StringToCharArray(text, bytes, 0, WHOLE_ARRAY, CP_UTF8);
   if(length > 0 && bytes[length - 1] == 0)
      length--;
   ArrayResize(bytes, MathMax(length, 0));
  }

//--- SHA-256 of `data`, which must not be empty, into `digest` (32 bytes).
bool DshSha256(const uchar &data[], uchar &digest[])
  {
   uchar unused[];
   return CryptEncode(CRYPT_HASH_SHA256, data, unused, digest) == DSH_SHA256_SIZE;
  }

//--- HMAC-SHA256 of `message` under `key`, into `mac` (32 bytes).
bool DshHmacSha256(const uchar &key[], const uchar &message[], uchar &mac[])
  {
   uchar block[];
   ArrayResize(block, DSH_SHA256_BLOCK);
   ArrayInitialize(block, 0);
   int keyLength = ArraySize(key);
   if(keyLength > DSH_SHA256_BLOCK)
     {
      uchar hashed[];
      if(!DshSha256(key, hashed))
         return false;
      ArrayCopy(block, hashed, 0, 0, DSH_SHA256_SIZE);
     }
   else
      if(keyLength > 0)
         ArrayCopy(block, key, 0, 0, keyLength);
   int messageLength = ArraySize(message);
   uchar inner[];
   ArrayResize(inner, DSH_SHA256_BLOCK + messageLength);
   for(int i = 0; i < DSH_SHA256_BLOCK; i++)
      inner[i] = (uchar)(block[i] ^ 0x36);
   if(messageLength > 0)
      ArrayCopy(inner, message, DSH_SHA256_BLOCK, 0, messageLength);
   uchar innerHash[];
   if(!DshSha256(inner, innerHash))
      return false;
   uchar outer[];
   ArrayResize(outer, DSH_SHA256_BLOCK + DSH_SHA256_SIZE);
   for(int i = 0; i < DSH_SHA256_BLOCK; i++)
      outer[i] = (uchar)(block[i] ^ 0x5c);
   ArrayCopy(outer, innerHash, DSH_SHA256_BLOCK, 0, DSH_SHA256_SIZE);
   return DshSha256(outer, mac);
  }

ushort DshHexDigit(const int value)
  {
   return (ushort)(value < 10 ? '0' + value : 'a' + value - 10);
  }

//--- Lowercase hex of `bytes`.
string DshHex(const uchar &bytes[])
  {
   int count = ArraySize(bytes);
   if(count == 0)
      return "";
   ushort digits[];
   ArrayResize(digits, count * 2);
   for(int i = 0; i < count; i++)
     {
      digits[2 * i] = DshHexDigit(bytes[i] >> 4);
      digits[2 * i + 1] = DshHexDigit(bytes[i] & 0x0F);
     }
   return ShortArrayToString(digits, 0, count * 2);
  }

//--- Hex SHA-256 of a string's UTF-8 bytes; "" for an empty string or when hashing fails.
string DshSha256Hex(const string text)
  {
   uchar data[];
   DshUtf8(text, data);
   uchar digest[];
   if(ArraySize(data) == 0 || !DshSha256(data, digest))
      return "";
   return DshHex(digest);
  }

//--- Hex HMAC-SHA256 of a message under a key, both strings taken as UTF-8; "" on failure.
string DshHmacHex(const string key, const string message)
  {
   uchar keyBytes[];
   uchar messageBytes[];
   uchar mac[];
   DshUtf8(key, keyBytes);
   DshUtf8(message, messageBytes);
   if(!DshHmacSha256(keyBytes, messageBytes, mac))
      return "";
   return DshHex(mac);
  }

//--- Whether two strings are equal, looking at every character whatever differs first, so the
//--- time taken does not tell an attacker how much of a forged proof was right.
bool DshSameText(const string a, const string b)
  {
   int length = StringLen(a);
   if(length != StringLen(b) || length == 0)
      return false;
   int difference = 0;
   for(int i = 0; i < length; i++)
      difference |= (int)(StringGetCharacter(a, i) ^ StringGetCharacter(b, i));
   return difference == 0;
  }

//--- 32 bytes as hex that never repeat. MQL5 has no secure random generator, so the nonce
//--- hashes the microsecond counter, both clocks, the last quote, terminal facts, a counter
//--- and the previous nonce. Uniqueness is what the handshake needs: the token, not the
//--- nonce, is the secret, and every proof binds both sides' nonces.
string DshNonce(void)
  {
   static string previous = "";
   static long counter = 0;
   counter++;
   MathSrand((uint)(GetMicrosecondCount() & 0x7FFFFFFF));
   string seed = previous
                 + "|" + IntegerToString((long)GetMicrosecondCount())
                 + "|" + IntegerToString((long)GetTickCount64())
                 + "|" + IntegerToString((long)TimeLocal())
                 + "|" + IntegerToString((long)TimeGMT())
                 + "|" + IntegerToString(counter)
                 + "|" + IntegerToString(MathRand()) + "-" + IntegerToString(MathRand())
                 + "|" + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_BID), 8)
                 + "|" + IntegerToString(TerminalInfoInteger(TERMINAL_MEMORY_USED))
                 + "|" + IntegerToString(ChartID())
                 + "|" + TerminalInfoString(TERMINAL_DATA_PATH)
                 + "|" + IntegerToString(GetMicrosecondCount());
   previous = DshSha256Hex(seed);
   return previous;
  }

//--- Whether `text` is 32 bytes of lowercase hex, as nonces, proofs and MACs are.
bool DshIsHex32(const string text)
  {
   if(StringLen(text) != 64)
      return false;
   for(int i = 0; i < 64; i++)
     {
      ushort c = StringGetCharacter(text, i);
      if(!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')))
         return false;
     }
   return true;
  }

//--- The hex digits of `text` in lowercase, whatever separators surround them.
string DshHexDigits(const string text)
  {
   string digits = text;
   StringToLower(digits);
   ushort kept[];
   int count = 0;
   ArrayResize(kept, StringLen(digits));
   for(int i = 0; i < StringLen(digits); i++)
     {
      ushort c = StringGetCharacter(digits, i);
      if((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))
         kept[count++] = c;
     }
   return count == 0 ? "" : ShortArrayToString(kept, 0, count);
  }

//--- A handshake proof (mt5/PROTOCOL.md): HMAC-SHA256 under the token of "dsh-mt5/2 <label>",
//--- the EA nonce, the Desktop nonce and the certificate fingerprint, one per line.
bool DshProofBytes(const string token, const string label, const string eaNonce, const string desktopNonce, const string fingerprint, uchar &proof[])
  {
   uchar key[];
   uchar message[];
   DshUtf8(token, key);
   DshUtf8("dsh-mt5/2 " + label + "\n" + eaNonce + "\n" + desktopNonce + "\n" + fingerprint, message);
   return ArraySize(key) > 0 && DshHmacSha256(key, message, proof);
  }

//--- The proof as lowercase hex; "" on failure.
string DshProof(const string token, const string label, const string eaNonce, const string desktopNonce, const string fingerprint)
  {
   uchar proof[];
   if(!DshProofBytes(token, label, eaNonce, desktopNonce, fingerprint, proof))
      return "";
   return DshHex(proof);
  }

//--- MAC of a signed request: HMAC-SHA256 under the session key of its id, type and body text,
//--- one per line, as lowercase hex; "" on failure.
string DshRequestMac(const uchar &sessionKey[], const string id, const string type, const string body)
  {
   uchar message[];
   uchar mac[];
   DshUtf8(id + "\n" + type + "\n" + body, message);
   if(ArraySize(sessionKey) != DSH_SHA256_SIZE || !DshHmacSha256(sessionKey, message, mac))
      return "";
   return DshHex(mac);
  }

//--- Checks SHA-256 and HMAC-SHA256 against published vectors: SHA-256("abc") from FIPS 180-2
//--- and RFC 4231 test cases 2 (a short key) and 6 (a key longer than the block). Returns ""
//--- when all pass, else what failed. A terminal that fails could never prove the token.
string DshCryptoSelfTest(void)
  {
   if(DshSha256Hex("abc") != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
      return "SHA-256 does not match FIPS 180-2";
   if(DshHmacHex("Jefe", "what do ya want for nothing?") != "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843")
      return "HMAC-SHA256 does not match RFC 4231 test case 2";
   uchar key[];
   ArrayResize(key, 131);
   ArrayInitialize(key, 0xaa);
   uchar message[];
   DshUtf8("Test Using Larger Than Block-Size Key - Hash Key First", message);
   uchar mac[];
   if(!DshHmacSha256(key, message, mac) || DshHex(mac) != "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54")
      return "HMAC-SHA256 does not match RFC 4231 test case 6";
   return "";
  }
//+------------------------------------------------------------------+
