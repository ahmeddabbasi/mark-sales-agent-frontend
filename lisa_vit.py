import os
from dotenv import load_dotenv
import queue
import json
import sounddevice as sd
import numpy as np
import wave
import random
import threading
from datetime import datetime
from vosk import Model, KaldiRecognizer
from openai import OpenAI
from TTS.api import TTS
import time
import gspread
from oauth2client.service_account import ServiceAccountCredentials

# === CONFIGURATION ===
load_dotenv()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
GOOGLE_CRED_JSON = os.getenv("GOOGLE_CRED_JSON")
SHEET_NAME = os.getenv("SHEET_NAME")
CONVERSATION_SCRIPT_PATH = os.getenv("CONVERSATION_SCRIPT_PATH", "conversation_script.txt")
VOSK_MODEL_PATH = "vosk-model-small-en-us-0.15"
SPEAKER_ID_SOFT = "p226"
SPEAKER_ID_ENERGETIC = "p228"
SAMPLERATE = 16000
DEVICE_INDEX = None

# === Setup Google Sheets ===
scope = ["https://spreadsheets.google.com/feeds", "https://www.googleapis.com/auth/drive"]
creds = ServiceAccountCredentials.from_json_keyfile_name(GOOGLE_CRED_JSON, scope)
client_sheet = gspread.authorize(creds)
sheet = client_sheet.open(SHEET_NAME).sheet1

# === Load conversation script ===
print("Loading conversation script...")
with open(CONVERSATION_SCRIPT_PATH, "r", encoding="utf-8") as f:
    sales_script_text = f.read()

conversation_history = [
    {"role": "system", "content": sales_script_text}
]

checklist = {"name_collected": False, "email_collected": False}

# === Initialize audio ===
DEVICE_INDEX = None
if DEVICE_INDEX is not None:
    sd.default.device = DEVICE_INDEX
else:
    sd.default.device = sd.query_devices(kind='input')['name']

audio_queue = queue.Queue()
frames = []
conversation_segments = []  # List of (source, audio_chunk)

print("Loading Vosk STT...")
if not os.path.exists(VOSK_MODEL_PATH):
    raise FileNotFoundError(f"Vosk model not found at {VOSK_MODEL_PATH}")
vosk_model = Model(VOSK_MODEL_PATH)
recognizer = KaldiRecognizer(vosk_model, SAMPLERATE)

client = OpenAI(api_key=OPENAI_API_KEY)

print("Loading VCTK VITS voice...")
tts = TTS(model_name="tts_models/en/vctk/vits", progress_bar=False, gpu=False)

# === Helpers ===
def detect_angry(text):
    angry_words = ["not happy", "angry", "upset", "mad", "terrible", "worst", "ridiculous", "hate"]
    return any(word in text.lower() for word in angry_words)
 
def ask_gpt_full(prompt):
    conversation_history.append({"role": "user", "content": prompt})
    completion = client.chat.completions.create(
        model="gpt-4o",
        messages=conversation_history
    )
    reply = completion.choices[0].message.content.strip()
    conversation_history.append({"role": "assistant", "content": reply})
    return reply

def stream_speech(text, speaker_id):
    wav = tts.tts(text=text, speaker=speaker_id)
    wav = np.array(wav).astype(np.float32)
    # Resample AI audio to match mic input sample rate (16000 Hz, int16)
    from scipy.signal import resample
    target_len = int(len(wav) * SAMPLERATE / 22050)
    wav_resampled = resample(wav, target_len)
    wav_int16 = (wav_resampled * 32767).astype(np.int16)
    conversation_segments.append(("ai", wav_int16))
    try:
        with sd.OutputStream(samplerate=22050, channels=1, dtype='float32') as stream:
            stream.write(wav)
    except Exception as e:
        print(f"❌ TTS Error: {e}")

def check_required_info_before_exit():
    missing = []
    if not checklist["name_collected"]:
        missing.append("name")
    if not checklist["email_collected"]:
        missing.append("email")
    if missing:
        return f"Before we wrap up, can I just get your {' and '.join(missing)} real quick?"
    return None

# === Mic callback ===
def callback(indata, frame_count, time, status):
    if status:
        print(".", status)
    audio_queue.put(bytes(indata))
    arr = np.frombuffer(indata, dtype=np.int16)
    frames.append(arr)
    conversation_segments.append(("customer", arr))

# === Main loop ===
def run_agent():
    global lead_interested  # track interest
    print("Lisa is ready and waiting for customer input...")

    # Greeting
    stream_speech("Hi, I'm Lisa from Pathburn, First AI-powered truck dispatcher. How are you today?", SPEAKER_ID_ENERGETIC)

    last_speech_time = time.time()

    with sd.InputStream(samplerate=SAMPLERATE, blocksize=8000, dtype='int16',
                       channels=1, callback=callback):
        while True:
            if time.time() - last_speech_time > 40:
                print("No response for 40 seconds. Ending call.")
                save_and_update()
                break
            data = audio_queue.get()
            if recognizer.AcceptWaveform(data):
                result = json.loads(recognizer.Result())
                text = result.get("text", "").strip()
                if not text:
                    continue
                last_speech_time = time.time()
                print("Recognized:", text)

                # ✅ Collect name/email if mentioned
                if "@" in text:
                    checklist["email_collected"] = True
                if any(w in text.lower() for w in ["my name is", "this is", "i am", "i'm"]):
                    checklist["name_collected"] = True

                # ✅ Detect prospect intent
                if any(w in text.lower() for w in ["send", "form", "yes", "let's do it", "follow up", "how do i start", "i'm interested", "okay", "i want"]):
                    lead_interested = True

                # Respond with acknowledgment + GPT reply
                speaker_id = SPEAKER_ID_ENERGETIC

                reply = ask_gpt_full(text)
                stream_speech(reply, speaker_id)
                last_speech_time = time.time()
    # Reset timer after bot replies

lead_interested = False  # becomes True only if prospect wants to close or follow up
checklist = {"name_collected": False, "email_collected": False}

# === Save local + update Google Sheet ===
def save_and_update():
    idx = input("Call finished. Enter the customer index from sheet: ").strip()
    feedback = input("Enter feedback about this call: ").strip()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    file_name = f"{idx}_{timestamp}.wav"

    if conversation_segments:
        # Concatenate all audio chunks in order
        all_audio = np.concatenate([chunk for source, chunk in conversation_segments]).flatten()
        with wave.open(file_name, 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLERATE)
            wf.writeframes(all_audio.tobytes())
        print(f"🎧 Call saved locally as {file_name}")

    all_records = sheet.get_all_records()
    found = False

    for i, row in enumerate(all_records, start=2):
        if str(row.get("index", "")).strip() == idx:
            sheet.update_cell(i, sheet.find("feedback").col, feedback)
            sheet.update_cell(i, sheet.find("call_status").col, "called")
            found = True
            break

    if found:
        if lead_interested:
            missing = []
            if not checklist["name_collected"]:
                missing.append("name")
            if not checklist["email_collected"]:
                missing.append("email")

            if missing:
                stream_speech(f"Before we wrap up, can I quickly get your {' and '.join(missing)}?", SPEAKER_ID_SOFT)
                return  # Wait for them to answer — script won't exit yet

        print("Google Sheet updated.")
        exit()
    else:
        print("Index not found in sheet.")
        idx = input("Enter the CORRECT customer index from sheet: ").strip()
        for i, row in enumerate(all_records, start=2):
            if str(row.get("index", "")).strip() == idx:
                sheet.update_cell(i, sheet.find("feedback").col, feedback)
                sheet.update_cell(i, sheet.find("call_status").col, "called")
                print("Google Sheet updated.")
                exit()

        print("❌ Still couldn't find index. Please check sheet manually.")
        exit()

# === Entry point ===
if __name__ == "__main__":
    try:
        run_agent()
    finally:
        save_and_update()
