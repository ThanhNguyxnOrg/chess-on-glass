# 16. Quyền phái sinh, clean-room và lựa chọn phát hành nguồn mở

**Ngày: 2026-11-07.** Phạm vi: (1) khi nào bản refactor vẫn là tác phẩm phái sinh; (2) thực hành clean-room có tài liệu; (3) các lựa chọn cho repo ChessOnGlass (bản sao "chesshacker" v0.2.0, không có LICENSE); (4) điều khoản reverse.dev cho "Clone this project"; (5) checklist phát hành OSS quốc tế. Chỉ đọc tài liệu công khai; không đăng ký tài khoản, không cài đặt, không liên hệ tác giả, không sửa repo (ngoài file này).

> **Thông tin tham khảo, không phải tư vấn pháp lý; hãy hỏi luật sư trước khi phát hành thương mại.**

## Cách đọc bằng chứng

- **Đã xác minh**: đã đọc trực tiếp trang/tài liệu (hoặc toàn văn trích xuất của tài liệu chính thức).
- **Chỉ mục**: mới thấy đoạn trích tìm kiếm, chưa đọc toàn văn.
- **Suy luận**: đánh giá/áp dụng cho ca này, chưa được chứng minh độc lập.

## 1. Refactor và tác phẩm phái sinh

- **Đã xác minh** — US Copyright Office, Circular 14 "Copyright in Derivative Works and Compilations" (toàn văn PDF tại https://www.copyright.gov/circs/circ14.pdf):
  - "A derivative work is a work based on or derived from one or more already existing works"; ví dụ được nêu đích danh gồm "**a new version of an existing computer program**".
  - "**Only the owner of copyright** in a work has the right to prepare, or to authorize someone else to create, an adaptation of that work"; "The unauthorized adaptation of a work may constitute copyright infringement."
  - Bản phái sinh chỉ được bảo hộ cho "the additions, changes, or other new material appearing for the first time"; bảo hộ "does not extend to any preexisting material". Dùng phần gốc khi chưa được phép thì bảo hộ không phủ phần dùng trái phép đó.
- **Đã xác minh** — 17 U.S.C. §102(b) (nguyên văn được trích trong syllabus SCOTUS): không bảo hộ "any idea, procedure, process, system, method of operation, concept, principle, or discovery". Ý tưởng/chức năng không thuộc độc quyền; nhưng mã nguồn cụ thể thường là "expression" được bảo hộ. Nguồn luật: https://www.copyright.gov/title17/92chap1.html#102
- **Đã xác minh** — EFF Reverse Engineering FAQ (https://www.eff.org/issues/coders/reverse-engineering-faq):
  - Sao chép có thể gồm "imitation of non-functional elements as well as verbatim duplication" — viết lại khác cú pháp không tự động xóa rủi ro.
  - Atari v. Nintendo: chương trình mở khóa bị coi không phải "independent creation" vì "substantially similar ... in ways not required to replicate the function", dù viết cho chip khác và bằng ngôn ngữ khác.
- **Suy luận — "refactor" đổi gì, không đổi gì:**
  - **Đổi**: code bạn tự viết có thể được bạn giữ quyền (chỉ phần mới); cấu trúc, đặt tên, nền tảng kỹ thuật có thể khác đi.
  - **Không đổi**: nghĩa vụ xin phép chủ sở hữu cho phần biểu đạt gốc còn lưu lại; tính phái sinh nếu bản mới còn "mang" phần sáng tạo gốc. Repo không có LICENSE **không** nghĩa là dùng tự do — GitHub ghi rõ: không license thì luật bản quyền mặc định áp dụng, "no one may reproduce, distribute, or create derivative works" (https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository); bài public vẫn cho người khác xem/fork theo GitHub ToS, nhưng không kèm quyền dùng (https://opensource.guide/legal/).
  - "Substantial similarity" là tiêu chí do tòa án xét trên phần biểu đạt được bảo hộ; phần trùng còn lại quyết định, không phải nhãn "refactor". Đây là đánh giá từng ca; không thể tự kết luận.

## 2. Clean-room: quy trình đã được ghi nhận

- **Đã xác minh** — EFF FAQ liệt kê thực hành chuẩn: chỉ tạo bản sao trung gian cần thiết; "Have the reverse engineering team that studies the code develop a **written manual** that describes the necessary interfaces in **purely functional terms**, then engage **separate developers** to build original code based on the manual and **without access to the copyrighted software**"; mua bản gốc hợp pháp; coi chừng điều khoản cấm reverse engineering.
- **Đã xác minh (nguồn thứ cấp)** — Phoenix BIOS: nhóm "contaminated" (đã đọc mã IBM) viết đặc tả API; nhóm "clean" (chưa từng thấy mã IBM) viết code từ đầu (https://www.historyofinformation.com/detail.php?id=3391 — trang tổng hợp, dẫn Wikipedia).
- **Đã xác minh** — Google v. Oracle (SCOTUS 2021, toàn văn: https://www.law.cornell.edu/supremecourt/text/18-956; PDF gốc: https://www.supremecourt.gov/opinions/20pdf/18-956_d18f.pdf): tòa **giả định** API có thể được bảo hộ nhưng chốt Google thắng fair use cho ~11.500 dòng declaring code **cần cho interoperability**; implementing code do Google **tự viết**. Đây là phán quyết theo tình huống API cụ thể, **không** phải giấy phép chung để sao chép code.
- **Đã xác minh** — Sega v. Accolade và Sony v. Connectix (theo bản tóm tắt EFF FAQ): copy trung gian để nghiên cứu interface có thể là fair use, nhưng sản phẩm cuối phải độc lập, không chứa mã gốc; Blizzard v. BnetD: hợp đồng (EULA/ToS có điều khoản cấm) có thể đánh bại fair use.
- **Suy luận — thực tế cho dev đơn độc:**
  - Wall hai nhóm khó với một mình: nếu bạn đã đọc code gốc, bạn khó tự tay chứng minh "clean". Thực hành giảm thiểu: viết đặc tả từ **hành vi quan sát được** (input/output, CLI, HTTP, trạng thái lỗi) trước; sau đó viết code mới, hạn chế đọc lại nguồn cũ; ghi provenance (ai đọc gì, ngày nào, quyết định nào).
  - Không sao chép phần phi chức năng (comment, tên biến đặc thù, cấu trúc, test suite) trừ khi cần cho tương thích — giữ chúng là dấu hiệu "không độc lập".
  - Clean-room chỉ giảm rủi ro **bản quyền**; không tự giải quyết thương hiệu, hợp đồng, sáng chế. Với repo này còn ràng buộc từ điều khoản reverse.dev (mục 4).

## 3. Ba lựa chọn cho repo ChessOnGlass

Bối cảnh: repo là bản sao chesshacker v0.2.0, không có LICENSE, `package.json` không có trường `license` (RESEARCH.md §10, §13).

### (a) Xin phép tác giả

- **Đã xác minh** kênh công khai duy nhất tìm thấy: GitHub profile https://github.com/picklerpeej (tồn tại; ghi NYC; **không có repo công khai** tại ngày khảo sát). `https://www.reverse.dev/p/picklerpeej` trả **404**; trang dự án https://www.reverse.dev/pjchess không có form liên hệ; `support@reverse.dev` là kênh của Reverse (Bubble Group, Inc.) theo Terms §1(g), **không phải** kênh của tác giả.
- **Đã xác minh** — MIT vs Apache-2.0:
  - MIT: ngắn; chỉ yêu cầu giữ copyright + license notice; không có điều khoản patent riêng (https://choosealicense.com/licenses/mit/).
  - Apache-2.0: thêm patent grant; phải đánh dấu "state changes" khi sửa file; kèm NOTICE; không cấp quyền thương hiệu (https://choosealicense.com/licenses/apache-2.0/).
  - Cả hai GPLv3-compatible; Apache-2.0 **không** tương thích GPLv2; FSF khuyên Apache-2.0 hơn các giấy phép lax khác cho chương trình lớn (https://www.gnu.org/licenses/license-list.html); FSF nói chung vẫn ưu tiên copyleft cho hầu hết chương trình (https://www.gnu.org/licenses/license-recommendations.html).
- **Suy luận** — ưu: cơ sở pháp lý rõ, giữ được credit, mở đường publish công khai. Nhược: có thể không được trả lời hoặc bị từ chối; phải chốt license **trước** khi publish. Nếu xin: nêu rõ mục đích, repo/phiên bản, license mong muốn (MIT hoặc Apache-2.0), cách ghi công.

### (b) Giữ riêng tư

- **Đã xác minh**: quyền tạo bản phái sinh thuộc chủ sở hữu (Circular 14) — để private không tạo ra license.
- **Suy luận**: giảm rủi ro bị phát hiện/takedown, tránh chính sách nền tảng; nhưng không đạt mục tiêu "publish international source project". Nếu chọn, nên coi đây là trạng thái trung gian để chuẩn bị clean-room (mục 2).

### (c) Cứ phát hành

- **Đã xác minh** — GitHub DMCA (https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy): chủ quyền gửi notice → GitHub có thể cho ~1 ngày làm việc để sửa/xóa, nếu không sẽ vô hiệu hóa repo; có counter-notice; chủ quyền có 10–14 ngày để khởi kiện trước khi nội dung được bật lại; tài khoản tái phạm bị khóa; notice/counter được công khai tại https://github.com/github/dmca; policy dẫn bối cảnh "statutory damages ... up to $150,000" cho một claim.
- **Đã xác minh** — reverse.dev Terms: §15 (takedown, khóa tài khoản tái phạm) và §4(g)(i) (cấm "connect any repository ... that you do not have the right to connect, access, or modify") — https://www.reverse.dev/terms.
- **Suy luận**: rủi ro nghiêng về phía người phát hành (mất repo, hậu quả tài khoản, danh tiếng; dự án đang hiển thị công khai trên reverse.dev với 40 clones). "Chưa bị kiện" không đồng nghĩa an toàn.

## 4. reverse.dev và "Clone this project"

- **Đã xác minh** — trang https://www.reverse.dev/pjchess có mục "Clone this project — Make this project your own and edit it easily with Reverse"; nút Clone trỏ tới `/signup?from=chess`, tức cần tài khoản.
- **Đã xác minh** — Terms (https://www.reverse.dev/terms; "Last revised September 16, 2026", hiệu lực 2026-09-21):
  - §3(a): license được cấp là "to access and use the Service" (giới hạn, thu hồi được); §3(b) cấm tạo derivative works **của Service** — không nói đến code của người dùng.
  - §6(f): người dùng "represent and warrant" có đủ quyền với Connected Repository; §4(g)(i) cấm kết nối repo không có quyền.
  - §8(b): giữa hai bên, **người dùng** giữ quyền với User Content của mình — không có điều khoản chuyển quyền giữa các nhà phát triển hay cấp quyền cho người clone.
- **Suy luận**: không có bằng chứng công khai nào cho thấy "Clone" cấp quyền sở hữu trí tuệ với code được clone; văn bản chỉ mô tả **quyền truy cập/dùng Service** và đặt trách nhiệm "bạn phải có quyền" lên người dùng. Muốn có quyền dùng code, phải xin từ tác giả (mục 3a). Luồng clone chi tiết sau đăng nhập chưa kiểm tra được (ràng buộc không đăng ký).

## 5. Checklist phát hành OSS quốc tế (ngắn)

Điều kiện tiên quyết: giải quyết quyền (mục 1–3). Checklist không thay thế tư vấn luật.

- **Chọn LICENSE** cho phần code bạn sở hữu: MIT hoặc Apache-2.0 (mục 3a); thêm trường `license` SPDX trong `package.json`. Nếu đóng gói chung với thành phần GPL (Stockfish GPLv3; ffmpeg-static 5.3.0 ghi GPL-3.0-or-later — RESEARCH.md §10 [R8]–[R10]), phải rà soát nghĩa vụ tương ứng trước khi chốt giấy phép và cách phân phối; RESEARCH.md §10 nêu chi tiết, không kết luận lại ở đây.
- **NOTICE/attribution**: giữ copyright/license của dependency; Stockfish cần license + đường tới source đúng bản phân phối; nếu dùng Apache-2.0, kèm NOTICE. README ghi công: "based on chesshacker by picklerpeej" (chuẩn mực; nhưng không thay thế quyền khi bản gốc không có LICENSE).
- **Hygiene trước publish**: CI cho build/test (repo hiện chưa thấy — RESEARCH.md §12); `SECURITY.md` (hướng dẫn báo lỗ hổng — https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository); `CONTRIBUTING.md`; cân nhắc DCO thay CLA (https://opensource.guide/legal/); SBOM/khóa phiên bản dependency; kiểm secrets, file rác, và cân nhắc tách lịch sử git chứa code chưa được cấp phép.
- **Quốc tế**: Công ước Berne — bảo hộ tự động, đối xử quốc gia, độc lập khỏi nơi công bố; quyền chuyển thể và quyền nhân thân (ghi tác giả) được nêu trong hiệp ước (https://www.wipo.int/en/web/treaties/ip/berne/summary_berne). Việt Nam là thành viên (Chỉ mục, theo thông báo WIPO). Giữ attribution/notice không chỉ là lịch sự mà là điều kiện thực tế của nhiều license.

## Nguồn chính

- Circular 14: https://www.copyright.gov/circs/circ14.pdf · §102: https://www.copyright.gov/title17/92chap1.html#102
- Google v. Oracle: https://www.law.cornell.edu/supremecourt/text/18-956 · https://www.supremecourt.gov/opinions/20pdf/18-956_d18f.pdf
- EFF RE FAQ: https://www.eff.org/issues/coders/reverse-engineering-faq · Phoenix: https://www.historyofinformation.com/detail.php?id=3391
- GitHub: DMCA https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy · license mặc định https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository
- reverse.dev: https://www.reverse.dev/terms · https://www.reverse.dev/pjchess · profile 404 đã kiểm chứng
- License: choosealicense https://choosealicense.com/licenses/mit/ https://choosealicense.com/licenses/apache-2.0/ · FSF https://www.gnu.org/licenses/license-list.html · https://www.gnu.org/licenses/license-recommendations.html
- OSS guide: https://opensource.guide/legal/ · Berne: https://www.wipo.int/en/web/treaties/ip/berne/summary_berne

## Bằng chứng còn thiếu

- Không rõ repo này được tạo bằng cách nào (tải về, clone qua reverse.dev hay cách khác) và ToS nào đã được chấp nhận khi lấy.
- Không có LICENSE của bản gốc; chưa kiểm tra tác giả có công bố license ở nơi khác không (GitHub không có repo công khai).
- Không xác minh ai là chủ sở hữu đầy đủ của cả 23 file gốc (đóng góp bên thứ ba/AI không kiểm chứng).
- Chưa xem được luồng clone sau đăng nhập (ràng buộc không đăng ký).
- Chưa liên hệ tác giả và chưa có phản hồi.
- Án lệ Sega/Connectix/Atari/Blizzard chỉ đọc qua tóm tắt EFF; Phoenix chỉ qua nguồn thứ cấp.
- Chưa có ý kiến luật sư cho trường hợp cụ thể (kể cả luật áp dụng: tác giả ở NYC, người dùng ở Việt Nam, nền tảng ở Hoa Kỳ).

## Cần người dùng quyết

1. Chiến lược tổng thể: (a) xin phép, (b) giữ private tạm, (c) clean-room rồi phát hành, hay (d) phát hành và chịu rủi ro.
2. Nếu xin phép: có liên hệ tác giả không; qua GitHub hay kênh khác; đề nghị MIT hay Apache-2.0; chờ bao lâu trước khi chuyển hướng nếu không phản hồi.
3. Có chấp nhận dùng nội bộ phần chưa có license không, hay chỉ tiếp tục khi có license hoặc clean-room hoàn chỉnh.
4. Có đầu tư clean-room thật (đặc tả hành vi trước, người thứ hai, hồ sơ provenance) hay chỉ refactor nội bộ.
5. Nơi phát hành (GitHub public, npm, cả hai), tên dự án (tách "ChessOnGlass" khỏi "chesshacker" thế nào) và thời điểm.
6. Có tách lịch sử git/xóa code gốc khỏi bản phát hành hay không (liên quan trực tiếp đến mục 1–2).
7. Ngân sách và thời điểm thuê luật sư trước khi phát hành thương mại.
