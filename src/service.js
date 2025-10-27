const fs = require("fs");
const path = require("path");
const morgan = require("morgan");
const express = require("express");
const rateLimit = require("express-rate-limit");
const yaml = require("yaml");

console.log("Starting hwidx-router service...");

const app = express();
const PORT = process.env.PORT || 8080;
const CONFIG_ROOT = process.env.CONFIG_ROOT || "config";
const DEBUG = process.env.DEBUG || false;

// Configure request logging via 'morgan'
app.use( morgan("tiny") );

// Basic rate limiting to prevent abuse
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

app.use(limiter);
//app.use(morgan('combined'));
//app.use(bodyParser.json());
//app.use(cors());

// Note that this may need additional work to be safe in production
function sanitizeInput(input) {
    if( input === null || input === undefined || input === "" )
        return null;
    
    return `${input}`.toLowerCase().replaceAll(/[/\\]/g, '');
}

app.get("/:prefix/:suffix", async (req, res, next) => {
  const org = sanitizeInput(req.params.prefix);
  const suffix = sanitizeInput(req.params.suffix);

  // Require all three components, othrwise bail immediately
  if (org === null || suffix === null)
    return res.sendStatus(400);

  const thisPath = `https://hwidx.org/${org}/${suffix}`;
  const webPath = `https://m.hwidx.org/${org}/${suffix}`;
  const dataPath = path.join(CONFIG_ROOT, org, `${suffix}.yml`);

  if (!fs.existsSync(dataPath)) {
    if (DEBUG)
      console.log(
        `Cannot route request for hwidx://${org}/${suffix} -> ??? (file not found: ${dataPath})`
      );
    return res.sendStatus(404);
  }

  try {
    const data = yaml.parse(fs.readFileSync(dataPath, "utf8"));
    if (data === null || data === undefined) return res.sendStatus(500);

    if( data.status && data.status.toLowerCase() == "pending" )
      return res.redirect(302, webPath);

    const redirect = data.url || null;
    if (redirect !== null) {
      if (DEBUG)
        console.log(
          `Routing request for hwidx://${org}/${suffix} -> ${dataPath} -> ${redirect}`
        );
      return res.redirect(302, redirect);
    }

    if (DEBUG)
      console.log(
        `Routing request for hwidx://${org}/${suffix} -> ${dataPath} -> ${webPath}`
      );
    return res.redirect(302, webPath);
  } catch (err) {
    console.error(`Error reading file at ${dataPath}:`, err);
    return res.sendStatus(500);
  }
});

app.get( "/status", (req, res) => {
    return res.status(200).send('OK');
});

app.use(async function(req, res){
    return res.status(404).send('Not Found');
});

const server = app.listen(PORT, () => {
  console.log(`hwidx-router service is running on port ${PORT}`);
});

function gracefulClose() {
  console.log("hwidx-router stopping...");
  server.close();

  console.log("hwidx-router stopped");
  process.exit( 0 );
}

process.on("SIGINT", gracefulClose);
process.on("SIGTERM", gracefulClose);


