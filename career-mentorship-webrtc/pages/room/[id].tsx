import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../../lib/supabaseClient";
import EmojiPicker from "emoji-picker-react";
import { FaPhone } from "react-icons/fa";
import toast, { Toaster } from "react-hot-toast";


import {
  FaMicrophone,
  FaMicrophoneSlash,
  FaVideo,
  FaVideoSlash,
  FaDesktop,
  FaPhoneSlash,
} from "react-icons/fa";

export default function RoomPage() {
  const router = useRouter();
  const { id: roomId } = router.query;

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);

  const [joined, setJoined] = useState(false);
  const [ended, setEnded] = useState(false);

  // call control state
  const [isMuted, setIsMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [micEnabled, setMicEnabled] = useState(true);
  const [isTyping, setIsTyping] = useState(false);
  const [typingUser, setTypingUser] = useState<string | null>(null);



  // CHAT STATES
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  // typing indicator state
const [remoteTyping, setRemoteTyping] = useState(false);
const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!roomId) return;
    initRoom();
    loadChatHistory();
    subscribeToChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const typingChannel = supabase
      .channel(`typing-${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "typing_status",
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => {
          setRemoteTyping(payload.new?.is_typing ?? false);
        }
      )
      .subscribe();

  }, [roomId]);

  // Mute/Unmute logic

  const toggleMic = () => {
    const stream = localVideoRef.current?.srcObject as MediaStream;

    if (!stream) return;

    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) return;

    audioTrack.enabled = !audioTrack.enabled;
    setMicEnabled(audioTrack.enabled);
  };


  // -------------------------------
  // 📌 LOAD OLD CHAT MESSAGES
  // -------------------------------
  const loadChatHistory = async () => {
    const { data, error } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("room_id", roomId)
      .order("created_at", { ascending: true });

    if (!error && data) setChatMessages(data);
  };

  // -------------------------------
  // 📌 REALTIME CHAT SUBSCRIPTION
  // -------------------------------
  const subscribeToChat = () => {
    supabase
      .channel(`chat-${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "chat_messages",
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => {
          setChatMessages((prev) => [...prev, payload.new as any]);
        }
      )
      .subscribe();
  };

  // -------------------------------
  // 📌 SEND CHAT MESSAGE
  // -------------------------------
  const sendMessage = async () => {
    if (!newMessage.trim()) return;

    await supabase.from("chat_messages").insert({
      room_id: roomId,
      sender: "user", // TODO: replace with real user id / name
      message: newMessage,
    });

    setNewMessage("");
  };

  // -------------------------------
  // 📌 INIT ROOM (WEBRTC + LOCK)
  // -------------------------------
  const initRoom = async () => {
    const { data: room, error } = await supabase
      .from("rooms")
      .select("*")
      .eq("id", roomId)
      .single();

    if (error || !room) {
      alert("Room not found.");
      router.push("/");
      return;
    }

    if (room.status !== "active") {
      alert("Room not active.");
      setEnded(true);
      return;
    }

    // AUTO-END SESSION AFTER TIMEOUT
    if (room.duration_minutes) {
      const durationMs = room.duration_minutes * 60 * 1000;

      setTimeout(async () => {
        await supabase
          .from("rooms")
          .update({ status: "ended", ended_at: new Date().toISOString() })
          .eq("id", roomId);
        setEnded(true);
        pcRef.current?.close();
      }, durationMs);
    }

    // Create PeerConnection
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pcRef.current = pc;

    // Local Stream
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    localStreamRef.current = stream;

    if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    // Remote Stream
    pc.ontrack = (event) => {
      if (remoteVideoRef.current)
        remoteVideoRef.current.srcObject = event.streams[0];
    };

    // ICE Candidates
    pc.onicecandidate = async (event) => {
      if (event.candidate) {
        await supabase.from("signals").insert({
          room_id: roomId,
          sender: "local",
          type: "ice",
          payload: event.candidate.toJSON(),
        });
      }
    };

    // SUBSCRIBE TO SIGNALS
    supabase
      .channel(`room-${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          table: "signals",
          schema: "public",
          filter: `room_id=eq.${roomId}`,
        },
        async (payload) => {
          const data: any = payload.new;
          if (data.sender === "local") return;

          if (data.type === "offer") {
            toast("Mentor joined the call", { icon: "👤" });
            await pc.setRemoteDescription(data.payload);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            await supabase.from("signals").insert({
              room_id: roomId,
              sender: "remote",
              type: "answer",
              payload: answer,
            });
          }

          if (data.type === "answer") {
            await pc.setRemoteDescription(data.payload);
          }

          if (data.type === "ice") {
            try {
              await pc.addIceCandidate(data.payload);
            } catch (err) {
              console.log("ICE error:", err);
            }
          }
        }
      )
      .subscribe();

    // CREATE OFFER IF FIRST PERSON
    const { data: signals } = await supabase
      .from("signals")
      .select("*")
      .eq("room_id", roomId);

    if (!signals || signals.length === 0) {
      // mentor
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      await supabase.from("signals").insert({
        room_id: roomId,
        sender: "local",
        type: "offer",
        payload: offer,
      });
    }

    setJoined(true);
    toast.success("You joined the session");

  };

  // ----------------------------------------
  // 📌 CALL CONTROLS
  // ----------------------------------------
  const toggleMute = () => {
    const stream = localStreamRef.current;
    if (!stream) return;

    const newMuted = !isMuted;
    stream.getAudioTracks().forEach((t) => {
      t.enabled = !newMuted;
    });
    setIsMuted(newMuted);
  };

  const toggleCamera = () => {
    const stream = localStreamRef.current;
    if (!stream) return;

    const newCameraOff = !cameraOff;
    stream.getVideoTracks().forEach((t) => {
      t.enabled = !newCameraOff;
    });
    setCameraOff(newCameraOff);
  };

  const startScreenShare = async () => {
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
      });
      const screenTrack = displayStream.getVideoTracks()[0];
      screenTrackRef.current = screenTrack;

      const pc = pcRef.current;
      if (pc) {
        const sender = pc
          .getSenders()
          .find((s) => s.track && s.track.kind === "video");
        if (sender) {
          sender.replaceTrack(screenTrack);
        }
      }

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = displayStream;
      }

      screenTrack.onended = () => {
        stopScreenShare();
      };

      setIsScreenSharing(true);
    } catch (err) {
      console.log("Screen share error:", err);
    }
  };

  const stopScreenShare = () => {
    const pc = pcRef.current;
    const stream = localStreamRef.current;
    const screenTrack = screenTrackRef.current;

    if (screenTrack) {
      screenTrack.stop();
      screenTrackRef.current = null;
    }

    if (pc && stream) {
      const videoTrack = stream.getVideoTracks()[0];
      const sender = pc
        .getSenders()
        .find((s) => s.track && s.track.kind === "video");
      if (sender && videoTrack) {
        sender.replaceTrack(videoTrack);
      }
    }

    if (localVideoRef.current && stream) {
      localVideoRef.current.srcObject = stream;
    }

    setIsScreenSharing(false);
  };

  const toggleScreenShare = () => {
    if (isScreenSharing) {
      stopScreenShare();
    } else {
      startScreenShare();
    }
  };

  // ----------------------------------------
  // 📌 END SESSION BUTTON
  // ----------------------------------------
  const handleEndSession = async () => {
    await supabase
      .from("rooms")
      .update({ status: "ended", ended_at: new Date().toISOString() })
      .eq("id", roomId);
    setEnded(true)
    toast.error("You ended the session");
    pcRef.current?.close();
  };

  if (ended) {
    return (
      <div style={{ paddingTop: "80px", textAlign: "center", color: "white" }}>
        <h2>Session Ended</h2>
        <button onClick={() => router.push("/")}>Back Home</button>
      </div>
    );
  }

  // -----------------------------
  // 📌 UI WITH CHAT SIDEBAR
  // -----------------------------
  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        background: "#111",
        color: "white",
      }}
    >
      {/* VIDEO AREA */}
      <div style={{ flex: 1, padding: "20px", position: "relative" }}>
        <h2 style={{ marginBottom: "10px" }}>Room ID: {roomId}</h2>
        {!joined && <p>Connecting...</p>}

        {/* Remote full-screen, local bottom-right */}
        <div
          style={{
            position: "relative",
            width: "100%",
            height: "75vh",
            background: "black",
            borderRadius: "10px",
            overflow: "hidden",
          }}
        >
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              background: "black",
            }}
          />
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            style={{
              position: "absolute",
              bottom: "20px",
              right: "20px",
              width: "260px",
              height: "160px",
              borderRadius: "14px",
              border: "2px solid #ffffffaa",
              objectFit: "cover",
              background: "black",
              boxShadow: "0 4px 16px rgba(0,0,0,0.6)",
            }}
          />

          {/* CALL CONTROL BAR - styled like your reference */}
          <div
            style={{
              position: "absolute",
              bottom: "20px",
              left: "50%",
              transform: "translateX(-50%)",
              display: "flex",
              alignItems: "center",
              gap: "16px",
            }}
          >
            {/* Mute / Unmute */}
            <button
              onClick={toggleMute}
              style={{
                width: 56,
                height: 56,
                borderRadius: "50%",
                border: "none",
                background: "#2b2b2b",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                boxShadow: "0 4px 12px rgba(0,0,0,0.6)",
              }}
            >
              {isMuted ? (
                <FaMicrophoneSlash size={22} color="#f5f5f5" />
              ) : (
                <FaMicrophone size={22} color="#f5f5f5" />
              )}
            </button>

            {/* Camera toggle */}
            <button
              onClick={toggleCamera}
              style={{
                width: 56,
                height: 56,
                borderRadius: "50%",
                border: "none",
                background: "#2b2b2b",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                boxShadow: "0 4px 12px rgba(0,0,0,0.6)",
              }}
            >
              {cameraOff ? (
                <FaVideoSlash size={22} color="#f5f5f5" />
              ) : (
                <FaVideo size={22} color="#f5f5f5" />
              )}
            </button>

            {/* End call (big red center button) */}
            <button
              onClick={handleEndSession}
              style={{
                width: 120,
                height: 48,
                borderRadius: "14px",
                border: "none",
                background: "#ff315f",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
              }}
            >
              <span
                style={{
                  fontSize: "14px",
                  fontWeight: "600",
                  color: "white",
                  letterSpacing: "0.5px",
                  fontFamily: "Inter, sans-serif",
                }}
              >
                End Session
              </span>
            </button>

            {/* Screen share */}
            <button
              onClick={toggleScreenShare}
              style={{
                width: 56,
                height: 56,
                borderRadius: "50%",
                border: "none",
                background: "#2b2b2b",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                boxShadow: "0 4px 12px rgba(0,0,0,0.6)",
              }}
            >
              <FaDesktop
                size={22}
                color={isScreenSharing ? "#4ade80" : "#f5f5f5"}
              />
            </button>
          </div>
        </div>
      </div>

      {/* CHAT SIDEBAR */}
      <div
        style={{
          width: "350px",
          background: "#1a1a1a",
          padding: "15px",
          borderLeft: "1px solid #333",
          display: "flex",
          flexDirection: "column",
          position: "relative",
        }}
      >
        <h3 style={{ marginBottom: "10px" }}>💬 Chat</h3>

        {remoteTyping && (
          <div style={{ fontSize: "12px", color: "#aaa", marginBottom: "6px" }}>
            Typing...
          </div>
        )}


        <div
          style={{
            flex: 1,
            overflowY: "scroll",
            border: "1px solid #333",
            padding: "10px",
            borderRadius: "8px",
            background: "#111",
          }}
        >
          {chatMessages.map((msg) => (
            <p key={msg.id} style={{ marginBottom: "8px", fontSize: "0.9rem" }}>
              <b>{msg.sender}:</b> {msg.message}
            </p>
          ))}
        </div>

        {/* Full Emoji Picker (Option A) */}
        {showEmojiPicker && (
          <div
            style={{
              position: "absolute",
              bottom: "70px",
              left: "15px",
              right: "15px",
              borderRadius: "10px",
              overflow: "hidden",
              boxShadow: "0 8px 20px rgba(0,0,0,0.7)",
            }}
          >
            <EmojiPicker
              theme="dark"
              width="100%"
              height={280}
              onEmojiClick={(emojiData) =>
                setNewMessage((prev) => prev + emojiData.emoji)
              }
            />
          </div>
        )}

        <div
          style={{
            marginTop: "10px",
            display: "flex",
            gap: "8px",
            alignItems: "center",
          }}
        >
          <button
            onClick={() => setShowEmojiPicker((prev) => !prev)}
            style={{
              padding: "8px 10px",
              background: "#333",
              borderRadius: "6px",
              border: "1px solid #444",
              cursor: "pointer",
            }}
          >
            😊
          </button>

          <input
            style={{
              flex: 1,
              padding: "8px",
              background: "#222",
              color: "white",
              borderRadius: "6px",
              border: "1px solid #444",
            }}
            value={newMessage}
            onChange={(e) => {
              setNewMessage(e.target.value);

              // notify typing
              supabase.from("typing_status").upsert({
                room_id: roomId,
                is_typing: true,
                updated_at: new Date().toISOString(),
              });

              // stop typing after delay
              if (typingTimeoutRef.current) {
                clearTimeout(typingTimeoutRef.current);
              }

              typingTimeoutRef.current = setTimeout(() => {
                supabase.from("typing_status").upsert({
                  room_id: roomId,
                  is_typing: false,
                  updated_at: new Date().toISOString(),
                });
              }, 1500);
            }}

            placeholder="Type message..."
          />

          <button
            style={{
              padding: "8px 14px",
              background: "#444",
              borderRadius: "6px",
              border: "none",
              cursor: "pointer",
            }}
            onClick={sendMessage}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
