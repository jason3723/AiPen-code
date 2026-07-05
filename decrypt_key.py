import base64
import nacl.secret
import nacl.pwhash

# Try key_tauri.pem (has standard rsign/minisign format)
with open("key_tauri.pem", "r") as f:
    content = f.read().strip()

lines = content.split("\n")
print(f"Comment: {lines[0]}")
key_b64 = lines[1]
print(f"Key b64 ({len(key_b64)} chars): {key_b64[:50]}...")

raw = base64.b64decode(key_b64)
print(f"Total: {len(raw)} bytes")

# Hex dump
for i in range(0, len(raw), 16):
    hex_part = " ".join(f"{b:02x}" for b in raw[i:i+16])
    ascii_part = "".join(chr(b) if 32 <= b < 127 else "." for b in raw[i:i+16])
    print(f"  {i:4d}: {hex_part:<48s} {ascii_part}")

# Parse based on minisign format
# Ed(2) | keynum(8) | chk_algo(2) | kdf_algo(2) | salt(32) | ops(8) | mem(8) | encrypted_sk(64) | encrypted_checksum(32)
magic = raw[0:2]
keynum = raw[2:10]
chk_algo = raw[10:12]
kdf_algo = raw[12:14]
salt = raw[14:46]
ops = int.from_bytes(raw[46:54], "little")
mem = int.from_bytes(raw[54:62], "little")
esk = raw[62:126]
echk = raw[126:158]
ct = raw[62:158]  # 96 bytes

print(f"\nmagic: {magic.hex()}")
print(f"keynum: {keynum.hex()}")
print(f"chk_algo: {chk_algo.hex()}")
print(f"kdf_algo: {kdf_algo.hex()} = {int.from_bytes(kdf_algo, 'little')}")
print(f"salt(32): {salt.hex()}")
print(f"ops: {ops}")
print(f"mem: {mem}")
print(f"esk(64): {esk.hex()[:40]}...")
print(f"echk(32): {echk.hex()[:40]}...")
print(f"ct(96): {len(ct)} bytes")

# KDF algorithm: 0x01 = scrypt, 0x02 = argon2id
kdf_id = int.from_bytes(kdf_algo, "little")
print(f"\nKDF ID: {kdf_id}")

password = b"lovkatrina-1314"
nonce = keynum + raw[46:54] + raw[54:62]
nonce = nonce.ljust(24, b"\x00")[:24]

if kdf_id == 0x01:
    print("Using scrypt...")
    key = nacl.pwhash.scrypt.kdf(
        nacl.secret.SecretBox.KEY_SIZE, password, salt,
        opslimit=ops, memlimit=mem
    )
elif kdf_id == 0x02:
    print("Using argon2id...")
    key = nacl.pwhash.argon2id.kdf(
        nacl.secret.SecretBox.KEY_SIZE, password, salt,
        opslimit=ops, memlimit=mem
    )
else:
    print(f"Unknown KDF: {kdf_id}, trying argon2id then scrypt...")
    try:
        key = nacl.pwhash.argon2id.kdf(
            nacl.secret.SecretBox.KEY_SIZE, password, salt,
            opslimit=ops, memlimit=mem
        )
        print("argon2id OK")
    except Exception as e1:
        print(f"argon2id failed: {e1}")
        key = nacl.pwhash.scrypt.kdf(
            nacl.secret.SecretBox.KEY_SIZE, password, salt,
            opslimit=ops, memlimit=mem
        )
        print("scrypt OK")

box = nacl.secret.SecretBox(key)
try:
    decrypted = box.decrypt(ct, nonce)
    print(f"\nDECRYPTED! ({len(decrypted)} bytes)")
    print(f"Hex: {decrypted[:20].hex()}...")
    
    # Write output
    out_b64 = base64.b64encode(decrypted).decode()
    with open("key_decrypted.pem", "w") as f:
        f.write("untrusted comment: minisign secret key\n")
        f.write(out_b64)
    print(f"\nTAURI_SIGNING_PRIVATE_KEY={out_b64}")
except Exception as e:
    print(f"Decryption failed: {e}")
    import traceback
    traceback.print_exc()
