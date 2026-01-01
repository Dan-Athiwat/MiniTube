# MiniTube (แยกไฟล์)

- ใช้ `index.html` เปิดแอป
- อัปโหลด/สร้างช่อง/คอมเมนต์/ติดตาม/ค้นหา ได้ทันที (ข้อมูลอยู่ใน IndexedDB)
- ตั้งค่า Base URL ในหน้าโปรไฟล์ แล้วกด “สร้างไฟล์สาธารณะทั้งหมด”
- ระบบจะดาวน์โหลด `channel.html`, `video-*.html`, `sitemap.xml`, `rss.xml`, `manifest.webmanifest`, `sw.js`
- อัปโหลดไฟล์เหล่านี้ไปโฮสต์ Static (Netlify/Vercel/GitHub Pages)
- ส่ง `sitemap.xml` เข้า Search Console เพื่อเร่งการจัดทำดัชนี

ข้อจำกัด: หน้า `video-*.html` ไม่ฝังไฟล์วิดีโอจากเครื่องคุณ ต้องอัปโหลดวิดีโอขึ้นคลาวด์แล้วแก้ `src` ในไฟล์นั้นเป็น URL จริง