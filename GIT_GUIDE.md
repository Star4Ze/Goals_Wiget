# Методичка по Git-синхронизации

Эта инструкция поможет хранить проект в GitHub и синхронизировать изменения между компьютерами.

## Первый раз: создать репозиторий

В папке проекта выполните:

```powershell
git init
git add .
git commit -m "Initial commit"
```

Создайте пустой репозиторий на GitHub, затем привяжите его:

```powershell
git remote add origin https://github.com/YOUR_NAME/Goals_Widget.git
git branch -M main
git push -u origin main
```

## Обычная работа

Перед началом работы заберите свежие изменения:

```powershell
git pull
```

После правок посмотрите, что изменилось:

```powershell
git status
```

Добавьте изменения и сохраните коммит:

```powershell
git add .
git commit -m "Describe changes"
```

Отправьте изменения на GitHub:

```powershell
git push
```

## На новом компьютере

```powershell
git clone https://github.com/YOUR_NAME/Goals_Widget.git
cd Goals_Widget
npm install
npm start
```

После клонирования проверьте путь `TARGET_DIR` в `main.js`, потому что папка Obsidian на новом компьютере может называться иначе.

## Что не хранить в Git

`.gitignore` уже исключает:

- `node_modules/`;
- `config.json`;
- `log.txt`;
- сборочные папки;
- локальные `.env` файлы;
- настройки редакторов.

`package-lock.json` хранить нужно: он помогает всем компьютерам ставить одинаковые версии зависимостей.

## Хороший ритм

1. Перед началом: `git pull`.
2. Сделали рабочую правку: `git status`.
3. Сохранили: `git add .` и `git commit -m "..."`.
4. Отправили: `git push`.

Так проект не потеряется и будет легко переноситься между машинами.
