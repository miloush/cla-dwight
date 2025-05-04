//
// CLA-dwight: A proxy to CLA-assistant for checking CLA signatures for an organization
//             Requires a GitHub personal access token with admin:org rights which it injects into the request
//
//             The data from CLA-assistant is cached and needs to be explicitly reloaded, as it costs several
//             sequential HTTP requests to obtain it. It is also requested at the start of the service.
//
// Provided endpoints:
//
//    BASE/list           Returns a list of all signatures of all users (as html, json or xml).
//                        Use ?reload=true to force using the most recent data.
//                        This call can optionally be password-protected (see CLA_LIST_AUTH).
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
//    CLA_LIST_AUTH       If present, /list will require basic HTTP authorization.
//                        The value should be space-separated base64-encoded username:password values.
//    CLA_AUTH_FIELDS     A space-separated list of field names in custom_fields that are considered private.
//                        The /list/username API will remove these fields unless client authorizes.
//    CLA_FILECACHE       Directory path where to store responses from CLA assistant as files.
//                        If present, the file data will be used when the call to the CLA assistant fails,
//                        unless reload is explicitly requested.
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

const app = express();
const router = express.Router();
const web = axios.create();

dotenv.config();
web.defaults.timeout = process.env.TIMEOUT || 30000;
app.set('view engine', 'pug');

const PORT = process.env.PORT || 3000;
const BASE = process.env.BASE || "/";
const CLA_ASSISTANT_URL = process.env.CLA_ASSISTANT_URL || "https://cla-assistant.io/";
const CLA_LIST_AUTH = process.env.CLA_LIST_AUTH ? process.env.CLA_LIST_AUTH.split(" ") : undefined;
const CLA_AUTH_FIELDS = process.env.CLA_AUTH_FIELDS ? process.env.CLA_AUTH_FIELDS.split(" ") : undefined;
const GITHUB_ORGID = process.env.GITHUB_ORGID;
const GITHUB_ORGTOKEN = process.env.GITHUB_ORGTOKEN;

const CLA_FILECACHE = process.env.CLA_FILECACHE || "";
const CLA_FILE_GIST = path.join(CLA_FILECACHE, "gist.json");
const CLA_FILE_SIGNEES = path.join(CLA_FILECACHE, "signees.json");

var globalError = false;
var globalGist = null;  // { url, filename, verions[]: { version, committed, url } }
var globalSignees = null; // Map of [] keyed by username (sorted list of signatures per user, newest first)

if (!GITHUB_ORGTOKEN) globalError = "GITHUB_ORGTOKEN environment variable not set.";
if (!GITHUB_ORGID) globalError = "GITHUB_ORGID environment variable not set.";

if (!globalError)
    await globalReload(/*ignoreErrors*/ true);

//#region Cache and File Cache

async function globalReload(ignoreErrors, disableCache)
{
    let gist = null;
    let signees = null;

    try
    {
        globalGist = gist = await getGist();
        globalSignees = signees = await getSignees();
        globalError = null;
    }
    catch (ex)
    {
        console.error(ex);

        if (CLA_FILECACHE && !disableCache)
            try
            {
                console.info("Trying data from file cache instead...");
                globalGist = await readCacheFile(CLA_FILE_GIST);
                globalSignees = await readCacheFile(CLA_FILE_SIGNEES);
                return;
            }
            catch (exfs)
            {
                console.error(exfs);
                ex = new AggregateError("Both CLA and file cache failed.", [ex, exfs]);
            }

        globalError = ex;
        if (!ignoreErrors)
            throw error;
    }

    if (CLA_FILECACHE && gist && signees)
        try
        {
            await writeCacheFile(CLA_FILE_GIST, gist);
            await writeCacheFile(CLA_FILE_SIGNEES, signees);
        }
        catch (ex)
        {
            console.error(ex);
        }
}

async function writeCacheFile(path, data)
{
    await fs.mkdir(CLA_FILECACHE, { recursive: true });

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

//#region Web Server

router.get('/status', (request, response) =>
{
    if (globalError)
        response.status(503).send(globalError.message);
    else
        response.status(200).send("OK");
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
    if (CLA_AUTH_FIELDS && needsAuthorization(request))
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

router.get('/list', async (request, response) =>
{
    if (needsAuthorization(request))
    {
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

            response.render('list',
                {
                    sortedSignees: sortedSignees,
                    fields: [...fields],
                    age: fresh ? undefined : formatTimeSpan(new Date() - signees.timestamp),
                    signatureCount: count
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
async function getSignees()
{
    const gist = globalGist;
    const perVersionSignatures = new Array(gist.versions.length);

    console.info("Getting list of signees...");

    //  The CLA server seems to be rate limiting concurrent connections, so reverting to sequential

    for (let i = 0; i < gist.versions.length; i++)
        perVersionSignatures[i] = await getSignatures(gist.versions[i].version);

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
function getSignatures(gistVersion)
{
    const gist = globalGist;

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

// Checks whether the client is authorized using one of the predefined acccounts
function needsAuthorization(request)
{
    if (!CLA_LIST_AUTH)
        return false;

    if (!request.headers.authorization)
        return true;

    try 
    {
        const auth = request.headers.authorization.split(" ");
        return auth[0] != "Basic" || CLA_LIST_AUTH.indexOf(auth[1]) < 0;
    }
    catch
    {
        return true;
    }
}
//#endregion

//#region Helpers

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
    return 0;
}

// Order by the last signature
function signeeComparer(a, b)
{
    // a, b Map entries, [1] signature array
    let val = signatureComparer(a[1][0], b[1][0]);
    return val;
}

//#endregion