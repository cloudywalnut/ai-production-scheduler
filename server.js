const express = require('express');
const fs = require('fs');
const cors = require('cors');
const axios = require("axios");
const multer = require("multer"); // Allows in Memory Storage
const FormData = require("form-data"); // Needed to Pass Data as a stream to openai
const path = require("path");
// const { Readable } = require("stream"); // Allows Creating Stream of Data

require("dotenv").config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() }); // keeps file in memory

// Allow ALL origins
app.use(cors());

// Getting the api key from the env file
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Essential Functions:

async function extractData(pdfStream) {
  try {

      console.log(`Reading PDF from ...`);

      // === UPLOAD FILE ===
      console.log("Uploading file to OpenAI...");

      // --- CHANGE 1: Create a FormData instance ---
      const form = new FormData();
      form.append('file', pdfStream); // Append the file stream
      form.append('purpose', 'assistants'); // Append the purpose field

      const uploadRes = await axios.post(
          "https://api.openai.com/v1/files",
          form, // --- CHANGE 2: Pass the entire FormData object as the data payload ---
          {
              headers: {
                  // --- CHANGE 3: Use form.getHeaders() to set the correct Content-Type with boundary ---
                  ...form.getHeaders(), 
                  "Authorization": `Bearer ${OPENAI_API_KEY}`,
                  // Remove "Content-Type": "multipart/form-data" here, form.getHeaders() provides it
              },
              // Removed redundant 'params', 'maxContentLength', and the incorrectly structured 'data' object
              maxBodyLength: Infinity, 
          }
      );

      const file_id = uploadRes.data.id;
      console.log(`File uploaded successfully with ID: ${file_id}`);

      // === GENERATE SUMMARY ===
      console.log("Requesting summary from OpenAI...");

      const prompt = `You are a professional Script Breakdown Specialist and Assistant Director.

          Your task is to extract scenes from the provided screenplay EXACTLY as they appear.
          You MUST follow these rules strictly:

          1. Do NOT add, invent, or hallucinate ANY information.
          2. Only extract what explicitly exists in the script.
          3. A scene begins ONLY when you detect a proper slugline:
          - INT.
          - EXT.
          - INT./EXT.
          - I/E.
          4. Never create scenes that do not exist.
          5. Never create characters, props, locations, or details that are not mentioned.
          6. If a field has no data in the script, return an empty array or empty string.

          OUTPUT REQUIREMENTS:
          Return a single JSON object containing a "scenes" array.
          Each item in the array MUST follow this schema strictly:

          {
          "scene_number": number,
          "scene_heading": "string",
          "location_type": "INT | EXT | INT/EXT | I/E | UNKNOWN",
          "location_name": "string or empty",
          "sub_location_name": "string or empty",
          "time_of_day": "DAY | NIGHT | UNKNOWN",
          "characters": ["list of character names"],
          "props": ["list of props"],
          "wardrobe": ["list of wardrobe details"],
          "set_dressing": ["list of set dressing elements"],
          "vehicles": ["list"],
          "vfx": ["list"],
          "sfx": ["list"],
          "stunts": ["list"],
          "extras": ["list"],
          "lines_count": number,
          "page_estimate": number,
          "scene_summary": "1–2 sentence factual summary using only information directly stated in the scene."
          "estimatedTime": "Provide the estimated shooting time in hours as a number, based on the length, number of characters, props, stunts, and complexity of the scene."
          }

      `;
      
      // Getting the response        
      const response = await axios.post(
          "https://api.openai.com/v1/responses",
          {
              model: "gpt-4.1-mini", // model name
              // max_output_tokens: 32000, // sets max token
              // temperature: 0, // more predictable answers
              // top_p: 0.1, // only words with highest probability chosen
              input: [
              {
                  role: "user",
                  content: [
                  {
                      type: "input_text",
                      text: prompt, // main prompt
                  },
                  {
                      type: "input_file",
                      file_id // Id of the file in concern
                  }
                  ]
              }
              ]
          },
          {
              headers: {
              "Authorization": `Bearer ${OPENAI_API_KEY}`, // OPENAI_API_KEY Parsed for authorization.
              "Content-Type": "application/json"
              }
          }
      );



      // ... rest of the code for summary processing and file deletion ...
      let summary =
          response.data.output?.[0]?.content?.[0]?.text ||
          "No information generated.";

      console.log("Summary generated successfully!");

      // === DELETE FILE ===
      try {
          await axios.delete(
              `https://api.openai.com/v1/files/${file_id}`,
              {
                  headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` }
              }
          );
          console.log(`File ${file_id} deleted from OpenAI.`);
      } catch (delErr) {
          console.log(`Warning: Failed to delete file ${file_id}:`, delErr);
      }

      // Returning the Summary
      summary = summary.replace(/```json\s*/g, "").replace(/```/g, "").trim(); // removes the backticks and stuff that comes due to json format
      summary = JSON.parse(summary);
      return summary;

  } catch (err) {
      // More descriptive error handling for the upload step
      console.log("Error in summarizePdfFromLocal():", err.message);
      if (err.response) {
          console.error("OpenAI API response data:", err.response.data);
      }
  }
}

function scheduleScenes(scenes, maxDayTime) {
    // Group scenes by location
    let locationMap = {};
    for (let scene of scenes) {
        if (!locationMap[scene.location_name]) locationMap[scene.location_name] = [];
        locationMap[scene.location_name].push(scene);
    }

    let days = [];
    let dayNumber = 1;

    // Keep scheduling until all scenes are assigned
    while (Object.keys(locationMap).length > 0) {
        let dayScenes = [];
        let dayTime = 0;

        
        for (let location in locationMap) {
            let locScenes = locationMap[location];

            // If no scenes then first include the scene with most character - makes overlap logical
            if (dayScenes.length == 0){
                const maxChars = Math.max(...locScenes.map(s => s.characters.length));
                const maxCharScenes = locScenes.filter(s => s.characters.length === maxChars);
                const firstScene = maxCharScenes[0]
                dayScenes.push(firstScene);
                dayTime += firstScene.estimatedTime;
                locScenes.splice(locScenes.indexOf(firstScene), 1); // remove scheduled scene
            }

            // Sort scenes to maximize character overlap with already scheduled scenes
            locScenes.sort((a, b) => {
                let overlapA = a.characters.filter(c => dayScenes.some(s => s.characters.includes(c))).length;
                let overlapB = b.characters.filter(c => dayScenes.some(s => s.characters.includes(c))).length;
                return overlapB - overlapA; // descending order
            });

            let i = 0;
            while (i < locScenes.length) {
                let scene = locScenes[i];

                if (dayTime + scene.estimatedTime <= maxDayTime) {
                    dayScenes.push(scene);
                    dayTime += scene.estimatedTime;
                    locScenes.splice(i, 1); // remove scheduled scene
                } else {
                    i++;
                }
            }

            // Remove location if empty
            if (locScenes.length === 0) delete locationMap[location];
        }

        days.push({day: dayNumber, scenes: dayScenes, totalTime: dayTime});
        dayNumber++;
    }

    return days;

}


// All Endpoints Start From Here

// serve HTML file
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "visualize.html"));
});

// The upload endpoint controls the main logic
app.post("/upload", upload.single("script"), async (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  console.log("Original file name:", req.file.originalname);
  console.log("File size (bytes):", req.file.size);

  // Convert buffer to stream if needed
  fs.writeFileSync("temp.pdf", req.file.buffer);
  const pdfStream = fs.createReadStream("temp.pdf");
  const extractedData = await extractData(pdfStream);
  const scheduledData = await scheduleScenes(extractedData.scenes,7);
  
  res.json({
    schedule: scheduledData,
  });

});

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});