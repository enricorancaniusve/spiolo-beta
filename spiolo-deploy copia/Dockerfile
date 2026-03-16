FROM node:20

# Crea la cartella dell'app
WORKDIR /usr/src/app

# Copia i file dei pacchetti
COPY package*.json ./

# Installa le dipendenze
RUN npm install

# Copia il resto del codice
COPY . .

# Espone la porta (Railpack userà la sua, ma noi dichiariamo la 3000)
EXPOSE 3000

# Comando di avvio
CMD [ "node", "server.js" ]
