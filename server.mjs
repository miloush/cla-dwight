//
// CLA-dwight: A proxy to CLA-assistant for checking CLA signatures for an organization
//             Requires a GitHub personal access token with admin:org rights which it injects into the request
//
//             The data from CLA-assistant is cached and needs to be explicitly reloaded, as it costs several
//             sequential HTTP requests to obtain it. It is also requested at the start of the service.
//
//             Separate local storage allows for uploading CLA signatures obtained offline.
//
// Provided endpoints:
//
//    BASE/file/filename  If CLA_FILELOCAL is set, servers locally stored CLA files.
//                        This call can optionally be password-protected (see CLA_LIST_AUTH).
//
//    BASE/list           Returns a list of all signatures of all users (as html, json or xml).
//                        Use ?reload=true to force using the most recent data.
//                        When local storage is enabled, accepts POST requests.
//                        This call can optionally be password-protected (see CLA_LIST_AUTH and CLA_SIGN_AUTH).
//
//    BASE/list/username  Returns a list of all signatures for a given GitHub username (as status, json or xml).
//                        404 no signature found, 200 valid signature exists, 410 signature revoked
//                        Use ?reload=true to force using the most recent data.
//                        Note that even if /list API is password protected, this one is not.
//
//    BASE/reload         Loads the most recent data from CLA-assistant into the cache, does not return anything.
//                        Has the same effect as ?reload=true above.
//
//    BASE/status         Returns 200 OK or 500 globalError (i.e. when GITHUB_ORG or GITHUB_ORGTOKEN is missing).
//                        When in error state, requests starting with /list path fail with 500.
//                        If the data request at startup fails, the global error state is also entered,
//                        but calling /reload will try to obtain the data again and if it succeeds, exit the error state.
//
// Environment variables:
//
//    PORT                Web server port (default: 3000).
//    TIMEOUT             CLA assistant timeout in ms (default: 30000).
//    BASE                URL prefix to serve (default: / i.e. /list etc.).
//
//    CLA_ASSISTANT_URL   Base URI for the CLA-assistant (default: https://cla-assistant.io/).
//    CLA_LIST_AUTH       If present, /list and /file will require basic HTTP authorization.
//                        The value should be space-separated base64-encoded username:password values.
//    CLA_AUTH_FIELDS     A space-separated list of field names in custom_fields that are considered private.
//                        The /list/username API will remove these fields unless client authorizes.
//    CLA_FILECACHE       Directory path where to store responses from CLA assistant as files.
//                        If present, the file data will be used when the call to the CLA assistant fails,
//                        unless reload is explicitly requested.
//    CLA_FILELOCAL       Directory path where to store local CLA files. If present, /list will render UI for uploading
//                        CLA signatures obtained offline, accept POST requests and store signatures locally.
//    CLA_SIGN_AUTH       If present, /list will require basic HTTP authorization to upload local files.
//                        The value should be space-separated base64-encoded username:password values.
//                        The list of credentials in CLA_LIST_AUTH and CLA_SIGN_AUTH do not need to overlap.
//
//    GITHUB_ORGID (required)     GitHub organization ID. This is a number and can be obtained from
//                                https://api.github.com/orgs/{organization username} (the id attribute).
//
//    GITHUB_ORGTOKEN (required)  PAT token with admin:org access to the GitHub organization.
//

import axios from 'axios';
import dotenv from 'dotenv';
import express from 'express';
import xml from 'xmlbuilder2';
import fs from 'fs/promises';
import path from 'node:path';
import multer from 'multer';
import { nanoid } from 'nanoid';

const app = express();
const router = express.Router();
const web = axios.create();

dotenv.config();
web.defaults.timeout = process.env.TIMEOUT || 30000;
app.set('view engine', 'pug');
app.locals.pretty = true;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BASE = process.env.BASE || "/";
const LOCALBASE = "/file";
const CLA_ASSISTANT_URL = process.env.CLA_ASSISTANT_URL || "https://cla-assistant.io/";
const CLA_LIST_AUTH = process.env.CLA_LIST_AUTH ? process.env.CLA_LIST_AUTH.split(" ") : undefined;
const CLA_SIGN_AUTH = process.env.CLA_SIGN_AUTH ? process.env.CLA_SIGN_AUTH.split(" ") : undefined;
const CLA_AUTH_FIELDS = process.env.CLA_AUTH_FIELDS ? process.env.CLA_AUTH_FIELDS.split(" ") : undefined;
const GITHUB_ORGID = process.env.GITHUB_ORGID;
const GITHUB_ORGTOKEN = process.env.GITHUB_ORGTOKEN;

const CLA_FILELOCAL = process.env.CLA_FILELOCAL || "";
const CLA_FILECACHE = process.env.CLA_FILECACHE || "";
const CLA_FILE_GIST = path.join(CLA_FILECACHE, "gist.json");
const CLA_FILE_SIGNEES = path.join(CLA_FILECACHE, "signees.json");
const CLA_DIR_UPLOADS = path.join(CLA_FILELOCAL, "uploads");
const CLA_DIR_SIGNEES = path.join(CLA_FILELOCAL, "signatures");

if (CLA_FILECACHE)
    await fs.mkdir(CLA_FILECACHE, { recursive: true });

if (CLA_FILELOCAL)
{
    await fs.mkdir(CLA_DIR_UPLOADS, { recursive: true });
    await fs.mkdir(CLA_DIR_SIGNEES, { recursive: true });
}

var globalError = false; // { message }
var globalGist = null;  // { url, filename, verions[]: { version, committed, url } }
var globalSignees = null; // Map of [] keyed by username (sorted list of signatures per user, newest first)

if (!GITHUB_ORGTOKEN) globalError = { message: "GITHUB_ORGTOKEN environment variable not set." };
if (!GITHUB_ORGID) globalError = { message: "GITHUB_ORGID environment variable not set." };

if (!globalError)
    await globalReload(/*ignoreErrors*/ true);

//#region Cache and File Cache

async function globalReload(ignoreErrors, disableCache)
{
    let gist = null;
    let signees = null;
    let gotCached = false;
    let localPromise = null;
    if (CLA_FILELOCAL)
        localPromise = getLocalSignatures();

    try
    {
        gist = await getGist();
        signees = await getSignees(gist);
        globalError = null;
    }
    catch (ex)
    {
        console.error(ex);

        if (CLA_FILECACHE && !disableCache)
            try
            {
                console.info("Trying data from file cache instead...");
                gist = await readCacheFile(CLA_FILE_GIST);
                signees = await readCacheFile(CLA_FILE_SIGNEES);
                gotCached = true;
                ex = null;
            }
            catch (exfs)
            {
                console.error(exfs);
                ex = new AggregateError("Both CLA and file cache failed.", [ex, exfs]);
            }

        globalError = ex;
        if (ex && !ignoreErrors)
            throw ex;
    }

    if (!gotCached && CLA_FILECACHE && gist && signees)
        try
        {
            console.info("Saving data to file cache...");
            await writeCacheFile(CLA_FILE_GIST, gist);
            await writeCacheFile(CLA_FILE_SIGNEES, signees);
        }
        catch (ex)
        {
            console.error(ex);
        }

    if (localPromise)
        try
        {
            const signatures = await localPromise;
            for (const signature of signatures)
                addLocalSignature(signees, signature, /*sort*/ true);
        }
        catch (exlo)
        {
            console.error(exlo);
        }

    globalGist = gist;
    globalSignees = signees;
}

function addLocalSignature(map, signature, sort)
{
    if (map.has(signature.user))
    {
        const signatures = map.get(signature.user);
        signatures.push(signature);
        if (sort)
            signatures.sort(signatureComparer);
    }
    else
        map.set(signature.user, [signature]);
}

async function writeCacheFile(path, data)
{
    const dataJson = JSON.stringify(data, function (key, value)
    {
        if (this[key] instanceof Map)
            value.__map = Array.from(value.entries());

        else if (this[key] instanceof Date)
            value = { __date: this[key].toJSON() };

        return value;
    })

    await fs.writeFile(path, dataJson);
}

async function readCacheFile(path)
{
    const dataJson = await fs.readFile(path, { encoding: 'utf8' });
    return JSON.parse(dataJson, function (key, value)
    {
        if (value)
        {
            if (value.__map)
            {
                const map = new Map(value.__map);
                Object.assign(map, value);
                return map;
            }
            else if (value.__date)
            {
                const date = new Date(value.__date);
                Object.assign(date, value);
                return date;
            }
            return value;
        }
    });
}
//#endregion

//#region Local Signatures

async function getLocalSignatures()
{
    if (!CLA_FILELOCAL)
        return [];

    console.info("Reading local signatures...");

    const files = await fs.readdir(CLA_DIR_SIGNEES);

    const promises = [];
    const signatures = [];
    for (const file of files)
    {
        const filePath = path.join(CLA_DIR_SIGNEES, file);
        const promise = fs.readFile(filePath, { encoding: 'utf8' });
        promise
            .then(function (data)
            {
                const signature = JSON.parse(data);
                signatures.push(signature);
            })
            .catch(function (error)
            {
                console.warn(`Skipping failed to read signature file: ${file}`, error);
            });

        promises.push(promise);
    }

    await Promise.allSettled(promises);
    return signatures;
}

function signatureFromUpload(request, formData)
{
    const uniqueId = nanoid();
    const now = new Date().toISOString();
    const signed = new Date(formData.signedDate).toISOString();
    const employer = formData.signerEmployer?.trim() || '';
    const isEmployed = employer && employer.toLowerCase() !== 'none';

    const category = isEmployed
        ? "(c) I am contributing as an individual because, even though I am employed, my employer has and claims no rights to my contributions."
        : "(b) I am contributing as an individual because I am self-employed or unemployed. I have read and agree to the CLA.";

    return {
        "_id": uniqueId,
        "created_at": signed,
        "updated_at": now,
        "custom_fields":
        {
            "name": formData.signerName || '',
            "email": formData.signerEmail || '',
            "employer": employer || "none",
            "category": category
        },
        "gist_url": encodeURIComponent(formData.fileName),
        "gist_filename": formData.fileOriginalName || formData.fileName,
        "origin": "local|" + getBasicUserName(request, CLA_SIGN_AUTH),
        "user": formData.signerEmail || ''
    };
}

async function writeLocalSignature(signature)
{
    const filePath = path.join(CLA_DIR_SIGNEES, `${signature.gist_url}.json`);

    await fs.writeFile(filePath, JSON.stringify(signature));
    return signature;
}

//#endregion

//#region Web Server

// HTML form file storage with filename override
const storage = multer.diskStorage(
    {
        destination: CLA_DIR_UPLOADS,
        filename: function (req, file, cb)
        {
            cb(/*err*/ null, nanoid());
        }
    });
const upload = multer(
    {
        storage,
        fileFilter: function (req, file, cb)
        {
            cb(/*err*/ null, !needsAuthorization(req, CLA_SIGN_AUTH));
        }
    });

router.get('/status', (request, response) =>
{
    if (globalError)
        response.status(503).send(globalError.message);
    else
        response.status(200).send("OK");
});

// serve uploaded files statically with authentication
if (LOCALBASE && CLA_DIR_UPLOADS)
    router.get(LOCALBASE + "/:filename", async (request, response) =>
    {
        if (needsAuthorization(request, CLA_LIST_AUTH))
        {
            response.set('WWW-Authenticate', 'Basic realm="CLA"');
            return response.status(401).send("Authorization required");
        }
        try
        {
            const filename = path.basename(request.params.filename);
            const localPath = path.join(CLA_DIR_UPLOADS, filename);
            const friendlyName = "CLA " + filename.split("#")[0] + path.extname(filename);
            response.download(localPath, friendlyName)
        }
        catch (ex)
        {
            console.error(ex);
            response.status(400);
        }
    });

router.get('/reload', async (request, response) =>
{
    try
    {
        await globalReload(/*ignoreErrors*/ false, /*disableCache*/ true);
        response.status(200).send("OK");
    }
    catch (error)
    {
        console.error(error);
        response.status(500).send("ERROR");
    }
});

router.get('/list/:username', async (request, response) =>
{
    if (request.query.reload == "true")
        await globalReload(/*ignoreErrors*/ false, /*disableCache*/ true);

    const signees = globalSignees;
    let signatures = signees.get(request.params.username);

    if (!signatures || signatures.length < 1)
    {
        response.status(404).send("Not found");
        return;
    }

    // remove private fields if not authorized
    if (CLA_AUTH_FIELDS && needsAuthorization(request, CLA_LIST_AUTH))
    {
        signatures = Array.from(signatures);
        for (let i = 0; i < signatures.length; i++)
        {
            if (signatures[i].custom_fields)
            {
                const censored = { ...signatures[i] };
                censored.custom_fields = { ...censored.custom_fields };
                for (const property of CLA_AUTH_FIELDS)
                    delete censored.custom_fields[property];
                signatures[i] = censored;
            }
        }
    }

    response.status(200);
    response.format({
        text()
        {
            // if not requesting full signature data, we only return whether a valid CLA is in place
            // the list is already ordered using signatureComparer, so first is most recent

            if (signatures.length > 0 && signatures[0].revoked_at)
                response.status(410).send("Revoked");
            else
                response.send("OK");
        },
        html() { this.text() },
        xml()
        {
            const root = { signatures: { '@timestamp': signees.timestamp.toISOString(), signature: signatures } };
            response.send(xml.create(root).end());
        },
        json() { response.send(signatures); },
        default() { this.text(); }
    });
});

router.all('/list', upload.single('cla'), async (request, response) =>
{
    const canUpload = CLA_FILELOCAL && !needsAuthorization(request, CLA_SIGN_AUTH);
    let uploadStatus = null;

    if (canUpload && request.method == "POST")
    {
        const { file, body } = request;

        if (file)
            try
            {
                const newName = path.basename(body["email"] + "#" + Date.now() + path.extname(file.originalname));
                const formData =
                {
                    fileName: newName,
                    fileOriginalName: path.basename(file.originalname),
                    signerName: body["name"],
                    signerEmail: body["email"],
                    signerEmployer: body["employer"],
                    signedDate: body["signed"]
                };

                if (!formData.signerName)
                    uploadStatus = "ERROR: Name is required.";
                else if (!formData.signerEmail)
                    uploadStatus = "ERROR: E-mail is required.";
                else if (!formData.signedDate)
                    uploadStatus = "ERROR: Signed date is required.";

                if (!uploadStatus)
                {
                    await fs.rename(file.path, path.join(CLA_DIR_UPLOADS, newName));

                    const signature = signatureFromUpload(request, formData);
                    await writeLocalSignature(signature);
                    addLocalSignature(globalSignees, signature, /*sort*/ true);

                    uploadStatus = "CLA added succesfully.";
                }
            }
            catch (ex)
            {
                uploadStatus = "ERROR: " + ex.message;
            }
        else
            uploadStatus = "ERROR: CLA file is required.";
    }

    if (needsAuthorization(request, CLA_LIST_AUTH))
    {
        if (uploadStatus) // user has write access but not read access
            return response.status(uploadStatus.startsWith("ERROR") ? 400 : 200).send(uploadStatus);

        response.set('WWW-Authenticate', 'Basic realm="CLA"');
        return response.status(401).send("Authorization required");
    }

    let fresh = false;
    if (request.query.reload == "true")
    {
        await globalReload(/*ignoreErrors*/ false, /*disableCache*/ true);
        fresh = true;
    }

    const signees = globalSignees;

    response.status(200);
    response.format({
        html()
        {
            const sortedSignees = [...signees].sort(signeeComparer); // Map entries
            const count = sortedSignees.reduce((c, s) => c + s[1].length, 0);

            // CLA can have custom fields (they can differ version to version),
            // collect all used ones into a set (for putting them into a table)
            const fields = signees.values().reduce((set, signee) =>
            {
                for (const signature of signee)
                    if (signature.custom_fields)
                    {
                        const keys = Object.keys(signature.custom_fields);
                        if (keys) keys.forEach(set.add, set);
                    }
                return set;
            }, new Set());

            response.render("list",
                {
                    sortedSignees,
                    fields: [...fields],
                    age: fresh ? undefined : formatTimeSpan(new Date() - signees.timestamp),
                    signatureCount: count,
                    canUpload,
                    uploadStatus,
                    localBase: combineUrl(request.originalUrl, ".." + LOCALBASE + "/"),
                    combineUrl
                });
        },
        xml()
        {
            const root = { signatures: { '@timestamp': signees.timestamp.toISOString(), signature: signees.values().flatMap(x => x).toArray() } };
            response.send(xml.create(root).end());
        },
        json() { response.send(signees); },
        default() { this.html(); }
    });
});

app.use("/list", (request, response, next) =>
{
    if (globalError)
        response.status(503).end();
    else
        next();
});

app.use((req, res, next) =>
{
    console.debug(`${req.method} ${req.originalUrl}`);
    next();
});

app.use(BASE, router);

app.listen(PORT, () =>
{
    console.log(`CLA-dwight running on port ${PORT}`);
});
//#endregion

//#region CLA Assistant

// Find gist for the organization
function getGist()
{
    console.info("Getting gist for the organization...");

    return web.post(CLA_ASSISTANT_URL + '/cla/getGist',
        {
            orgId: GITHUB_ORGID,
        })
        .then(function (response)
        {
            const gist =
            {
                url: response.data.html_url,
                filename: Object.keys(response.data.files).find(f => f != "metadata"),
                versions: response.data.history.map(h =>
                ({
                    version: h.version,
                    committed: h.committed_at,
                    url: h.url
                })),
            };

            console.debug("Found gist at: " + gist.url);
            if (gist.versions?.length > 0)
            {
                for (const version of gist.versions)
                    console.debug(" - version " + version.version + " from " + version.committed);

                return gist;
            }
            else
            {
                throw new Error("No gist history available.");
            }
        })
        .catch(function (error)
        {
            throw new Error("Failed to receive gist for the organization.", { cause: error });
        });
};

// Get list of all users who signed the CLA
// Note: Currently the CLA assistant fails unless we ask per version.
async function getSignees(gist)
{
    const perVersionSignatures = new Array(gist.versions.length);

    console.info("Getting list of signees...");

    //  The CLA server seems to be rate limiting concurrent connections, so reverting to sequential

    for (let i = 0; i < gist.versions.length; i++)
        perVersionSignatures[i] = await getSignatures(gist, gist.versions[i].version);

    const values = perVersionSignatures;

    //  return await Promise.all(perVersionSignatures)
    //      .then(function (values)
    //      {
    const signees = values.flat().reduce((map, signature) =>
    {
        if (map.has(signature.user))
            map.get(signature.user).push(signature);
        else
            map.set(signature.user, [signature]);
        return map;
    }, new Map());

    signees.timestamp = new Date();

    for (const signee of signees.values())
        signee.sort(signatureComparer);

    return signees;
    //      })
    //      .catch(function (error)
    //      {
    //          throw new Error("Failed to receive list of signees.", { cause: error });
    //      });
};

// Get list of all signatures for a specific version of the CLA
function getSignatures(gist, gistVersion)
{
    console.debug(`Getting signees for version ${gistVersion}...`);

    const versions = gist.versions.reduce((map, version) =>
    {
        map.set(version.version, version);
        return map;
    }, new Map());

    return web.post(CLA_ASSISTANT_URL + '/cla/getAll',
        {
            orgId: GITHUB_ORGID,
            gist:
            {
                gist_url: gist.url,
                gist_version: gistVersion
            },
            token: GITHUB_ORGTOKEN
        })
        .then(function (response)
        {
            var signatures = response.data;
            console.debug(` - found ${signatures.length} signatures for ${gistVersion}`);

            for (const signature of signatures)
            {
                const version = versions.get(signature.gist_version);
                if (version)
                    signature.gist_committed_at = version.committed;

                signature.gist_filename = gist.filename;

                if (signature.custom_fields)
                    signature.custom_fields = JSON.parse(signature.custom_fields);
            }

            return signatures;
        })
        .catch(function (error)
        {
            throw new Error(`Failed to receive list of signees for version ${gistVersion}.`, { cause: error });
        });
};
//#endregion

//#region Helpers

// Checks whether the client is authorized using one of the predefined acccounts
function needsAuthorization(request, authList)
{
    let user = getBasicUserName(request, authList);
    return !user;
}

// Gets the authorized client's username if it is one of the predefined accounts
function getBasicUserName(request, authList)
{
    if (!authList)
        return null;

    if (!request.headers.authorization)
        return null;

    try
    {
        const auth = request.headers.authorization.split(" ");
        if (auth[0] != "Basic" || authList.indexOf(auth[1]) < 0)
            return null;

        const credBuffer = Buffer.from(auth[1], "base64");
        const decoded = credBuffer.toString("utf8");
        return decoded.split(":")[0];
    }
    catch (ex)
    {
        console.error(ex);
        return null;
    }
}

// Naive date diff formatting
function formatTimeSpan(ms)
{
    const DAY = 86400 * 1000;
    const HOUR = 3600 * 1000;
    const MINUTE = 60 * 1000;

    const days = Math.floor(ms / DAY); ms -= days * DAY;
    const hours = Math.floor(ms / HOUR); ms -= hours * HOUR;
    const minutes = Math.floor(ms / MINUTE);

    if (ms < MINUTE)
        return "less than a minute";

    var str = " ";

    if (days > 0) str += days + " days ";
    if (hours > 0) str += hours + " hours ";
    if (minutes > 0) str += minutes + " minutes ";

    return str.trim();
}

// Order by signed date descending, then version date descending
function signatureComparer(a, b)
{
    // the dates are strings but in a sortable format
    if (a.created_at < b.created_at) return 1;
    if (a.created_at != b.created_at) return -1;

    if (a.gist_committed_at < b.gist_committed_at) return 1;
    if (a.gist_committed_at != b.gist_committed_at) return -1;

    if (a.updated_at < b.updated_at) return 1;
    if (a.updated_at != b.updated_at) return -1;
    return 0;
}

// Order by the last signature
function signeeComparer(a, b)
{
    // a, b Map entries, [1] signature array
    let val = signatureComparer(a[1][0], b[1][0]);
    return val;
}

// This is new URL(url, base) but allowing base to be relative
function combineUrl(base, url)
{
    const absoluteBase = new URL(base, "local://");
    const combined = new URL(url, absoluteBase);
    if (combined.protocol == "local:")
        return combined.pathname;

    return combined;
}

//#endregion
