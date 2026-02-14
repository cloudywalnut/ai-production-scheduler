const express = require('express');
const fs = require('fs');
const cors = require('cors');
const axios = require("axios");
const multer = require("multer"); // Allows in Memory Storage
const FormData = require("form-data"); // Needed to Pass Data as a stream to openai
const path = require("path");
const { PDFDocument } = require("pdf-lib");
// const { Readable } = require("stream"); // Allows Creating Stream of Data

require("dotenv").config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() }); // keeps file in memory

// Allow ALL origins
app.use(cors());

// Getting the api key from the env file
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Essential Functions:

// Wants to Chunk Pdf
async function chunkPDF(buffer, pagesPerChunk = 30) {
  const pdf = await PDFDocument.load(buffer);
  const totalPages = pdf.getPageCount();

  const chunks = [];

  for (let i = 0; i < totalPages; i += pagesPerChunk) {
    const chunk = await PDFDocument.create();
    const pages = await chunk.copyPages(
      pdf,
      Array.from({ length: Math.min(pagesPerChunk, totalPages - i) }, (_, j) => i + j)
    );
    pages.forEach(p => chunk.addPage(p));

    const bytes = await chunk.save();
    chunks.push(bytes);
  }

  return chunks;
}

// Extracting Data
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
          The start of every scene will have a slugline which will contain the location_type like EXT/INT, the
          location name, the sublocation name and the time of day for example DAY/NIGHT or others. Strictly make sure
          not to miss any scenes. 

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
          "estimatedTime": "Provide the estimated shooting time in hours as a number, based on the length of the scene. A 1 page
                            scene would take 2 hours, a 2 page scene would take 4 hours, shorter half page scenes would take 1 hour
                            and so on."
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

      try {
        summary = JSON.parse(summary);
      } catch {
        summary = { scenes: [] }; // safe fallback
      }

      return summary;

  } catch (err) {
      // More descriptive error handling for the upload step
      console.log("Error in summarizePdfFromLocal():", err.message);
      if (err.response) {
          console.error("OpenAI API response data:", err.response.data);
      }
  }
}

// Scheduling Scenes
function scheduleScenes(scenes, maxDayTimeHours) {
    // Get locations sorted by most scenes first
    let locationSceneMap = getLocationsSortedBySceneCount(scenes);
    let shootingDays = [];
    let currentDayNumber = 1;

    // Continue scheduling until all scenes are assigned
    while (Object.keys(locationSceneMap).length > 0) {
        let dayScenes = [];
        let totalDayTimeUsed = 0;

        for (let locationName in locationSceneMap) {
            // If remaining day time is 4 hours or less, don't change location (avoid pack-up)
            if (maxDayTimeHours - totalDayTimeUsed <= 4) {
                continue;
            }

            // Sort sub-locations with most scenes first - The EXTD, INTD, INTN, EXTN Sort function is inside this function
            locationSceneMap[locationName] = sortSubLocationsBySceneCount(locationSceneMap[locationName]);
            let locationScenes = locationSceneMap[locationName];

            let sceneIndex = 0;
            while (sceneIndex < locationScenes.length) {
                let scene = locationScenes[sceneIndex];

                // Schedule scene if it fits in the day, or if it's the last scene at this location
                const willSceneFit = totalDayTimeUsed + scene.estimatedTime <= maxDayTimeHours;
                const isLastSceneAtLocation = locationScenes.length === 1;
                
                if (willSceneFit || isLastSceneAtLocation) {
                    dayScenes.push(scene);
                    totalDayTimeUsed += scene.estimatedTime;
                    locationScenes.splice(sceneIndex, 1); // Remove scheduled scene
                } else {
                    sceneIndex++;
                }
            }

            // Remove location if all scenes have been scheduled
            if (locationScenes.length === 0) {
                delete locationSceneMap[locationName];
            }
        }

        // Sort scenes within the day from MORNING to EVENING
        const timeOfDayOrder = ["MORNING", "EVENING", "NIGHT", "UNKNOWN"];
        dayScenes.sort((sceneA, sceneB) => {
            return timeOfDayOrder.indexOf(sceneA.time_of_day) - timeOfDayOrder.indexOf(sceneB.time_of_day);
        });

        shootingDays.push({
            day: currentDayNumber,
            scenes: dayScenes,
            totalTime: totalDayTimeUsed
        });
        
        currentDayNumber++;
    }

    return shootingDays;
}

// Group scenes by location and sort locations by scene count
function getLocationsSortedBySceneCount(scenes) {
    // Group scenes by location
    let locationMap = {};
    
    for (let scene of scenes) {
        const locationName = scene.location_name;
        
        if (!locationMap[locationName]) {
            locationMap[locationName] = [];
        }
        
        locationMap[locationName].push(scene);

        // Track scene count per location
        if (locationMap[locationName].sceneCount) {
            locationMap[locationName].sceneCount += 1;
        } else {
            locationMap[locationName].sceneCount = 1;
        }
    }

    // Sort locations by scene count (most scenes first)
    locationMap = Object.fromEntries(
        Object.entries(locationMap)
            .sort((locationA, locationB) => locationB[1].sceneCount - locationA[1].sceneCount)
    );

    return locationMap;
}

// Sort scenes within a location by sub-location (most scenes first)
function sortSubLocationsBySceneCount(locationScenes) {
    let subLocationSceneCount = {};
    let sortedScenes = [];

    // Count scenes per sub-location
    locationScenes.forEach(scene => {
        const subLocationName = scene.sub_location_name;
        subLocationSceneCount[subLocationName] = (subLocationSceneCount[subLocationName] || 0) + 1;
    });

    // Sort sub-locations by scene count (most scenes first)
    subLocationSceneCount = Object.fromEntries(
        Object.entries(subLocationSceneCount).sort((a, b) => b[1] - a[1])
    );

    // Process each sub-location in order
    for (let subLocationName in subLocationSceneCount) {
        let subLocationScenes = locationScenes.filter(scene => 
            scene.sub_location_name === subLocationName
        );
        
        let sortedSubLocationScenes = sortScenesByLocationType(subLocationScenes);
        sortedScenes.push(...sortedSubLocationScenes);
    }

    return sortedScenes;
}

// Sort scenes by location type and time of day
function sortScenesByLocationType(scenes) {
    const sortedScenes = [];

    // Order of preference for scheduling:
    // 1. EXT + DAY/EVENING
    sortedScenes.push(...scenes.filter(scene => 
        scene.location_type === "EXT" && 
        (scene.time_of_day === "DAY" || scene.time_of_day === "EVENING")
    ));
    
    // 2. INT + DAY/EVENING
    sortedScenes.push(...scenes.filter(scene => 
        scene.location_type === "INT" && 
        (scene.time_of_day === "DAY" || scene.time_of_day === "EVENING")
    ));
    
    // 3. INT + NIGHT
    sortedScenes.push(...scenes.filter(scene => 
        scene.location_type === "INT" && 
        scene.time_of_day === "NIGHT"
    ));
    
    // 4. EXT + NIGHT
    sortedScenes.push(...scenes.filter(scene => 
        scene.location_type === "EXT" && 
        scene.time_of_day === "NIGHT"
    ));

    // 5. All other scenes
    const knownSceneIds = new Set(sortedScenes.map(scene => scene.scene_number));
    const otherScenes = scenes.filter(scene => !knownSceneIds.has(scene.scene_number));
    
    sortedScenes.push(...otherScenes);
    
    return sortedScenes;
}


// All Endpoints Start From Here

// serve HTML file
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "visualize.html"));
});

// Just Extracts the Data
app.post("/extract", upload.single("script"), async (req, res) => {
    if (!req.file) return res.status(400).send("No file uploaded");

    console.log("Original file name:", req.file.originalname);
    console.log("File size (bytes):", req.file.size);

    // Convert buffer to stream if needed
    const folderName = `temp_${Date.now()}`
    fs.mkdirSync(folderName)

    let masterData = [];
    const pdfChunks = await chunkPDF(req.file.buffer)
    let i = 1
    for (const chunk of pdfChunks){
        fs.writeFileSync(`${folderName}/chunk_${i}.pdf`, chunk);
        i = i+1;
    }
  
    // Now used to retrieve files
    const files = fs.readdirSync(folderName);
    for (const fileName of files){
        console.log("Now Processing File: " + fileName);
        const pdfStream = fs.createReadStream(`${folderName}/${fileName}`);
        const extractedData = await extractData(pdfStream);
        masterData.push(...extractedData.scenes);
    }

    fs.rmSync(folderName, { recursive: true, force: true });

    res.json({
    scenesData: masterData,
    });

});

// The upload endpoint controls the main logic
app.post("/schedule", upload.single("script"), async (req, res) => {
    if (!req.file) return res.status(400).send("No file uploaded");

    console.log("Original file name:", req.file.originalname);
    console.log("File size (bytes):", req.file.size);

    // Convert buffer to stream if needed
    const folderName = `temp_${Date.now()}`
    fs.mkdirSync(folderName)

    let masterData = [];
    const pdfChunks = await chunkPDF(req.file.buffer)
    let i = 1
    for (const chunk of pdfChunks){
        fs.writeFileSync(`${folderName}/chunk_${i}.pdf`, chunk);
        i = i+1;
    }
  
    // Now used to retrieve files
    const files = fs.readdirSync(folderName);
    for (const fileName of files){
        console.log("Now Processing File: " + fileName);
        const pdfStream = fs.createReadStream(`${folderName}/${fileName}`);
        const extractedData = await extractData(pdfStream);
        masterData.push(...extractedData.scenes);
    }

    const scheduledData = await scheduleScenes(masterData,12);

    fs.rmSync(folderName, { recursive: true, force: true });

    res.json({
    schedule: scheduledData,
    });

});


// The endpoint to take in voice commands and convert it to some actionable function to run on frontend
app.post("/voice", upload.single("audio"), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }
    console.log('Received file:', req.file);
    res.send({ message: 'Audio received', filename: req.file.filename });
})



app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});