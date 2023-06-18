# Tweetbot v2 (Scraping Edition)
----

Continually checks twitter channels for new tweets and posts them to discord webhooks. 

Mainly utilises puppeteer to performn headless browser requests and uses twitter based query selectors to extract relevant data. 

Build with docker (e.g.):
```
docker build . -t <name>/<etc>:<tag>
```

Run with docker (e.g.):
```
docker run -i --init --rm --cap-add=SYS_ADMIN --env-file ./.env --name <container_name> <name>/<etc>:<tag> 
```

Need populate a `.env` file, or pass in env variables to docker some other way for the MongoDB and Logging Webhook.

