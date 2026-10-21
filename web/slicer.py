#Created by Pucur

import os

MANIFEST_FILE = "game-manifest.txt"
GAME_SOURCE_DIR = "game"
TARGET_BLOCKS_DIR = "blocks"
CHUNK_SIZE = 64 * 1024  # 64 KB

def slice_from_manifest():
    if not os.path.exists(MANIFEST_FILE):
        print(f"[HIBA] A manifest fájl ({MANIFEST_FILE}) nem található!")
        return

    print("[INFO] Szeletelés indítása a hivatalos manifest lista alapján...")

    with open(MANIFEST_FILE, "r", encoding="utf-8") as f:
        lines = f.readlines()

    for line in lines:
        parts = line.strip().split()
        if len(parts) < 2:
            continue
        
        file_hash = parts[0]
        file_rel_path = parts[1]
        
        source_path = os.path.join(GAME_SOURCE_DIR, file_rel_path)
        
        if not os.path.exists(source_path):
            print(f"[FIGYELEM] Cannot find in game: {source_path}")
            continue

        file_size = os.path.getsize(source_path)
        total_chunks = (file_size + CHUNK_SIZE - 1) // CHUNK_SIZE
        
        target_sub_dir = os.path.join(TARGET_BLOCKS_DIR, file_rel_path)
        os.makedirs(target_sub_dir, exist_ok=True)

        print(f"[SLICING] {file_rel_path} (Hash: {file_hash}) -> {total_chunks} chunk...")

        with open(source_path, "rb") as f_src:
            for i in range(total_chunks):
                chunk_data = f_src.read(CHUNK_SIZE)
                chunk_filename = f"{file_hash}-{i}-64k.bin"
                chunk_target_path = os.path.join(target_sub_dir, chunk_filename)
                
                if not os.path.exists(chunk_target_path):
                    with open(chunk_target_path, "wb") as f_chunk:
                        f_chunk.write(chunk_data)

    print("[DONE]")

if __name__ == "__main__":
    slice_from_manifest()
