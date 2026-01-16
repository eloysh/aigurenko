import { GoogleGenAI } from "@google/genai";

export async function generateNanoBananaImage({ apiKey, prompt, aspectRatio = "9:16" }) {
  const ai = new GoogleGenAI({ apiKey });

  // Nano Banana (быстро) — gemini-2.5-flash-image
  // Nano Banana Pro (качество) — gemini-3-pro-image-preview  :contentReference[oaicite:2]{index=2}

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-image",
    contents: prompt,
    config: {
      imageConfig: { aspectRatio },
    },
  });

  const parts = response?.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p) => p.inlineData);

  if (!img?.inlineData?.data) {
    throw new Error("NanoBanana: image not returned");
  }

  return {
    base64: img.inlineData.data,
    mime: img.inlineData.mimeType || "image/png",
  };
}
