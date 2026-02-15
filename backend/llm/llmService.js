const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_SECONDARY_API_KEY = process.env.GROQ_SECONDARY_API_KEY;

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

async function generateResponse({ messages }, useSecondary = false) {
  const key = useSecondary ? GROQ_SECONDARY_API_KEY : GROQ_API_KEY;

  if (!key) {
    if (!useSecondary && GROQ_SECONDARY_API_KEY) {
      return generateResponse({ messages }, true);
    }
    throw new Error("No Groq API key found");
  }

  const body = {
    model: MODEL,
    messages,
    temperature: 0.6,
  };

  try {
    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      if (!useSecondary && GROQ_SECONDARY_API_KEY) {
        console.warn("[LLM] Primary key failed, trying secondary...");
        return generateResponse({ messages }, true);
      }
      throw new Error(`Groq LLM error: ${errText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();
  } catch (err) {
    if (!useSecondary && GROQ_SECONDARY_API_KEY) {
      console.warn("[LLM] Primary key error, trying secondary...");
      return generateResponse({ messages }, true);
    }
    throw err;
  }
}

module.exports = { generateResponse };