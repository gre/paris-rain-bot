/* eslint-disable no-console */
const exec = require("child_process").exec;
const get = require("lodash/get");
const range = require("lodash/range");
const url = require("url");
const fetch = require("isomorphic-fetch");
const fs = require("fs");
const path = require("path");
const moment = require("moment");

moment.relativeTimeThreshold("m", 3*60);

const configFile = process.argv[2];

const config = JSON.parse(fs.readFileSync(configFile));

const gitDir = path.resolve(__dirname, config.forkDir);

const now = () => Date.now();
const delay = d => new Promise(resolve => setTimeout(resolve, d));

const readFile = file =>
new Promise((resolve,reject) =>
  fs.readFile(file, (err, data) => {
    if (err) reject(file);
    else resolve(data);
  }));

const writeFile = (file, data) =>
new Promise((resolve,reject) =>
  fs.writeFile(file, data, (err) => {
    if (err) reject(file);
    else resolve();
  }));

const existsFile = file => new Promise(resolve => fs.exists(file, resolve));

const command = (cmd, opts) =>
new Promise((resolve, reject) =>
  exec(
    cmd,
    opts,
    (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    }));

const gitClone = () =>
command("git clone "+config.repository+" "+config.forkDir, { cwd: __dirname });

const git = subcmd => command("git "+subcmd, { cwd: gitDir });

const fetchCurrentWeather = () =>
  fetch(url.format({
    protocol: "http",
    host: "api.openweathermap.org",
    pathname: "/data/2.5/weather",
    query: config.OpenWeatherMapQuery
  }))
  .then(res => res.status!==200 ? new Error(res.statusText) : res.json());

const log = msg =>
  console.log(
    moment().format("DD/MM/YY HH:mm")+
    ": "+
    msg
  );

const ONE_HOUR = 3600 * 1000;

function main (state, save) {
  const setState = newState => save(state = Object.assign({}, state, newState));
  if (!state) {
    setState({
      weather: null,
      totalRain: 0,
      timeLastFetch: 0,
      timeLastCommit: 0
    });
  }
  log("Start with " + JSON.stringify(state));

  // weather check

  function weatherCheck () {
    return fetchCurrentWeather()
    .then(weather => {
      const getNormalized = field =>
        get(weather, [field, "1h"], 0) ||
        (1/3) * get(weather, [field, "3h"], 0) ||
        (1/6) * get(weather, [field, "6h"], 0) ||
        (1/12) * get(weather, [field, "12h"], 0) ||
        (1/24) * get(weather, [field, "24h"], 0) ||
        (1/24) * get(weather, [field, "day"], 0);
      const rainLastHour = getNormalized("rain") + getNormalized("snow");
      log("rain += "+rainLastHour);
      setState({
        weather,
        totalRain: state.totalRain + rainLastHour,
        timeLastFetch: now()
      });
    })
    .catch(e => console.warn("Failed to get weather: "+e))
    .then(scheduleNextWeatherCheck);
  }
  function scheduleNextWeatherCheck () {
    const nextWeatherCheck = Math.max(0, ONE_HOUR-(now()-state.timeLastFetch));
    log("Will do next weather check in "+moment.duration(nextWeatherCheck).humanize());
    return delay(nextWeatherCheck).then(weatherCheck);
  }

  // commit rain!

  function commitRain () {
    const weather = state.weather;
    const droplets = range(Math.floor(state.totalRain)).map(() =>
      get(state.weather, "snow.3h") ? "⛷" : "💧"
    ).join("")+" ";
    const weatherDesc = get(weather, "weather[0].description", "unknown");
    const date = moment(state.timeLastFetch).format("MMMM Do YYYY [around] hh:mm a");
    const body =
    "## It rained the last time in "+get(weather, "name", "???")+" on *"+date+"*\n"+
    droplets+" **"+weatherDesc+"** "+
    "*Humidity "+get(state.weather, "main.humidity", "?")+"%*\n\n"+
    weather.weather.map(w => "!["+w.description+"](http://openweathermap.org/img/w/"+w.icon+".png)").join(" ");
    const description = droplets;
    return command("echo '"+body+"' > README.md", { cwd: gitDir })
    .then(() => git("commit -a -m '"+description+"'"))
    .then(() => git("push origin master"))
    .then(() => ({ date, description }));
  }

  function scheduleNextCommit () {
    if (state.totalRain >= 1 && state.totalRain * (now()-state.timeLastCommit) > ONE_HOUR) {
      return commitRain()
      .then(o => {
        log(o.date+" commit "+o.description);
        setState({
          totalRain: state.totalRain - 1,
          timeLastCommit: now()
        });
      })
      .catch(e => (console.warn("Failed to commit rain: "+e), delay(10000)))
      .then(scheduleNextCommit);
    }
    // check again in 30s (minimal interval in extreme case)
    return delay(30000).then(scheduleNextCommit);
  }

  scheduleNextWeatherCheck();
  scheduleNextCommit();
}

existsFile(config.forkDir)
.then(exists => exists ? git("pull origin master") : gitClone())
.then(() => existsFile(config.stateFile))
.then(exists => exists ? readFile(config.stateFile).then(JSON.parse) : null)
.then(state => main(state, newState => writeFile(config.stateFile, JSON.stringify(newState))))
.catch(error => console.error(error));
