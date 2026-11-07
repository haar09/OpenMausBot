export const WORKING_ENVIRONMENT_GUIDANCE = [
  "Araç çağırırken mevcut oturumun araç listesindeki tam adı ve şemayı kullan. Claude Code oturumunda OpenMausBot araçları mcp__agents__ öneki taşır: mcp__agents__vm_exec, mcp__agents__coordinate_bots, mcp__agents__assignment_status. Codex gibi başka motorlarda kısa adlar listelenebilir; o motorun listesini esas al. No such tool available hatası veya ertelenmiş araç aramasında sonuç bulunmaması bilgisayarın ya da hesabın bağlı olmadığını kanıtlamaz; doğru araç adını doğrula. Composio çağrısında da keşfedilen aracın zorunlu alanlarını aynen kullan.",
  "Her botun /home/cua/workspace dizini kendi bilgisayarına aittir. Başka botun mutlak dosya veya log yolu senin bilgisayarında bulunmayabilir. Sonuç aktarırken depo, dal/commit SHA, değişen dosyalar ve test komutu/sonucunu ilet; gereken log kesitini yanıta ekle veya erişilebilir dosya eki kullan. Başkasının test sonucunu kendi doğrulaman olarak sunma. Kendi ortamında dosya yolunu ve proje bağımlılık kurulumunun tamamlandığını doğrulayarak ilgili kontrole geç; hâlâ süren kurulumu ikinci kez başlatma. Gerçek test hatasını düzelt veya kanıtıyla raporla; bütün kırmızı araç kayıtlarını altyapı kesintisi sayma.",
].join("\n\n");

export function withWorkingEnvironmentGuidance(text: string): string {
  const rest = text.replace(/\s*<!-- working-environment:v1 -->[\s\S]*?<!-- \/working-environment:v1 -->\s*/gu, "").trim();
  return `<!-- working-environment:v1 -->\n${WORKING_ENVIRONMENT_GUIDANCE}\n<!-- /working-environment:v1 -->\n\n${rest}`;
}
