import { useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { v4 as uuidv4 } from "uuid";
import { useRouter } from "next/router";

export default function Home() {
  const router = useRouter();
  const [duration, setDuration] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  // ✅ Create a new session (room)
  const handleCreateSession = async () => {
    if (!duration) {
      alert("Please select a session duration first.");
      return;
    }
    setLoading(true);

    try {
      // insert new room record
      const { data, error } = await supabase
        .from("rooms")
        .insert([
          {
            mentor_id: uuidv4(), // you can replace with actual logged-in mentor ID later
            duration_minutes: duration,
            status: "active",
          },
        ])
        .select()
        .single();

      if (error) throw error;

      // redirect mentor to that room
      router.push(`/room/${data.id}`);
    } catch (err: any) {
      console.error("Error creating session:", err.message);
      alert("Failed to create room. Check console for details.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        fontFamily: "sans-serif",
      }}
    >
      <h1>🎓 Start a Mentorship Session</h1>
      <p>Select duration:</p>

      <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
        {[10, 30, 45].map((time) => (
          <button
            key={time}
            onClick={() => setDuration(time)}
            style={{
              background: duration === time ? "#0070f3" : "#e0e0e0",
              color: duration === time ? "white" : "black",
              border: "none",
              borderRadius: "8px",
              padding: "10px 20px",
              cursor: "pointer",
            }}
          >
            {time} min
          </button>
        ))}
      </div>

      <button
        onClick={handleCreateSession}
        disabled={loading}
        style={{
          marginTop: "20px",
          padding: "10px 20px",
          backgroundColor: "#0070f3",
          color: "white",
          border: "none",
          borderRadius: "8px",
          cursor: "pointer",
        }}
      >
        {loading ? "Creating..." : "Start Session"}
      </button>
    </div>
  );
}
