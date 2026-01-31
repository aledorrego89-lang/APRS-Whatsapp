sudo apt update
sudo apt install nodejs npm git

git clone https://github.com/pedroslopez/whatsapp-web.js

sudo apt update && sudo apt upgrade -y

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

mkdir aprs-whatsapp-gateway
cd aprs-whatsapp-gateway
npm init -y

npm install whatsapp-web.js qrcode-terminal net

Crear el index.js

node index.js

